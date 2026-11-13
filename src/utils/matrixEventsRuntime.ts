/**
 * Effects of the Matrix event channel (contract: docs/matrix_events.md).
 *
 * - `FNHARNESS_EVENTS=<file>`: append one JSON line per event.
 * - `FNHARNESS_INPUT=<fifo>`: read one JSON line per incoming message.
 *
 * Both are off by default. Without the variables every function in this module
 * returns immediately: nothing is opened, written or read. All the logic that
 * can be pure lives in `matrixEvents.ts`; this file only holds the file
 * descriptors, the timers and the glue to the REPL, and never throws into the
 * caller (a broken channel must not take the session down).
 */

import { randomUUID } from 'crypto'
import { closeSync, constants, openSync, readSync, statSync, writeSync } from 'fs'
import { getOriginalCwd, getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { sessionAccountId } from '../services/api/accountRouting.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { logForDebugging } from './debug.js'
import { getMainLoopModel } from './model/model.js'
import {
  buildEvent,
  buildAskAnswers,
  drainLines,
  initialFlow,
  parseInputLine,
  serializeEvent,
  stepFlow,
  tallyMcp,
  trimEntryForEvent,
  type AskQuestion,
  type EventBody,
  type FlowAction,
  type FlowEvent,
  type FlowState,
  type InputMessage,
  type MatrixCap,
  type SessionSwitchReason,
  type TurnEndReason,
  type TurnSource,
} from './matrixEvents.js'

// ── event sink (FNHARNESS_EVENTS) ────────────────────────────────────────

export type SinkFs = {
  open: (path: string) => number
  write: (fd: number, data: string) => void
  close: (fd: number) => void
}

export const realSinkFs: SinkFs = {
  // Append, create with 0600: the events carry prompts' lengths, tool names and questions.
  open: path => openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600),
  write: (fd, data) => {
    writeSync(fd, data)
  },
  close: fd => closeSync(fd),
}

export type EventSink = {
  emit: (body: EventBody) => void
  close: () => void
}

/**
 * Sink that appends events to `path`. `seq` advances for every event, written
 * or not, so a reader can see that something was lost. Any failure (open or
 * write) is swallowed; the next event tries again.
 */
export function createEventSink(
  path: string,
  getSession: () => string,
  fs: SinkFs = realSinkFs,
  now: () => Date = () => new Date(),
): EventSink {
  let fd: number | null = null
  let seq = 0
  return {
    emit(body) {
      seq += 1
      try {
        if (fd === null) fd = fs.open(path)
        // One write per line: a `tail -f` reader never sees half a line.
        fs.write(fd, serializeEvent(buildEvent({ seq, now: now(), sessionId: getSession() }, body)))
      } catch (e) {
        if (fd !== null) {
          try {
            fs.close(fd)
          } catch {}
          fd = null
        }
        logForDebugging(`[matrix-events] no se pudo escribir ${path}: ${String(e)}`)
      }
    },
    close() {
      if (fd === null) return
      try {
        fs.close(fd)
      } catch {}
      fd = null
    },
  }
}

let cachedSink: { path: string; sink: EventSink } | null = null

function currentSink(): EventSink | null {
  const path = process.env.FNHARNESS_EVENTS
  if (!path) return null
  if (cachedSink?.path !== path) {
    cachedSink?.sink.close()
    cachedSink = { path, sink: createEventSink(path, () => String(getSessionId())) }
  }
  return cachedSink.sink
}

/** True when either channel is switched on. */
export function matrixChannelActive(): boolean {
  return Boolean(process.env.FNHARNESS_EVENTS || process.env.FNHARNESS_INPUT)
}

/** Writes one event; a no-op without FNHARNESS_EVENTS. */
export function emitMatrix(body: EventBody): void {
  // `session_start` is always the first event: nothing goes out before it.
  if (!initialized && body.type !== 'session_start') {
    // Transcript entries and `mcp_settled` can be produced before the REPL announces the session:
    // keep them (bounded) and send them right after `session_start`.
    if ((body.type === 'entry' || body.type === 'mcp_settled') && process.env.FNHARNESS_EVENTS) {
      if (preInit.length < PRE_INIT_MAX) preInit.push(body)
    }
    return
  }
  try {
    currentSink()?.emit(body)
  } catch {}
}

const PRE_INIT_MAX = 1000
const preInit: EventBody[] = []

// ── transcript entries (v2) ──────────────────────────────────────────────

/** uuid of the user message injected for a FIFO prompt → the `id` of that prompt. */
const inputIds = new Map<string, string>()
const INPUT_IDS_MAX = 200
/** `system/turn_duration` entries seen; the deferred `turn_end` waits for the next one on long turns. */
let turnDurationCount = 0

/**
 * Emits one `entry` event with the exact object appended to the main
 * transcript (trimmed for size, see `trimEntryForEvent`). Called synchronously
 * by the session storage when it queues the line for the file. A no-op without
 * FNHARNESS_EVENTS.
 */
export function matrixEmitEntry(entry: Record<string, unknown>): void {
  if (!process.env.FNHARNESS_EVENTS) return
  try {
    if (entry.type === 'system' && entry.subtype === 'turn_duration') turnDurationCount++
    let inputId: string | undefined
    if (entry.type === 'user' && typeof entry.uuid === 'string') {
      inputId = inputIds.get(entry.uuid)
      if (inputId !== undefined) inputIds.delete(entry.uuid)
    }
    const trimmed = trimEntryForEvent(entry)
    emitMatrix({
      type: 'entry',
      entry: trimmed.entry,
      ...(inputId !== undefined ? { input_id: inputId } : {}),
      ...(trimmed.truncated ? { truncated: true as const } : {}),
    })
  } catch (e) {
    logForDebugging(`[matrix-events] no se pudo emitir entry: ${String(e)}`)
  }
}

/** Remembers which FIFO prompt a user message (by uuid) came from, to stamp `input_id` on its entry. */
function rememberInputId(uuid: string, id: string): void {
  if (!process.env.FNHARNESS_EVENTS) return
  if (inputIds.size >= INPUT_IDS_MAX) {
    const oldest = inputIds.keys().next().value
    if (oldest !== undefined) inputIds.delete(oldest)
  }
  inputIds.set(uuid, id)
}

/** Transcript recordings in progress (`recordTranscript`): the end of a turn waits for them. */
let recordingsInFlight = 0

/** Marks a transcript recording as started; call the returned function when it ends. */
export function matrixRecordingStart(): () => void {
  if (!process.env.FNHARNESS_EVENTS) return () => {}
  recordingsInFlight++
  let done = false
  return () => {
    if (done) return
    done = true
    recordingsInFlight = Math.max(0, recordingsInFlight - 1)
  }
}

// ── flow controller (ready / queue) ──────────────────────────────────────

type Controls = {
  /** Sends `text` to the REPL as a prompt typed by the user. */
  submit: (text: string, uuid: string) => void
  /** Same as pressing Escape. */
  interrupt: () => void
}

let flow: FlowState = initialFlow
let controls: Controls | null = null
let nextSource: TurnSource | null = null
/** uuid of prompts injected through the FIFO → the source their turn reports. */
const injected = new Map<string, TurnSource>()
let initialized = false
let lastSessionId = ''
let submitTimer: ReturnType<typeof setTimeout> | null = null

function dispatch(event: FlowEvent): void {
  const result = stepFlow(flow, event)
  flow = result.state
  for (const action of result.actions) runAction(action)
}

function runAction(action: FlowAction): void {
  switch (action.kind) {
    case 'emit':
      emitMatrix(action.body)
      return
    case 'interrupt':
      try {
        controls?.interrupt()
      } catch (e) {
        logForDebugging(`[matrix-events] interrupt falló: ${String(e)}`)
      }
      return
    case 'submit': {
      const uuid = randomUUID()
      injected.set(uuid, action.source)
      rememberInputId(uuid, action.id)
      try {
        controls?.submit(action.text, uuid)
      } catch (e) {
        injected.delete(uuid)
        logForDebugging(`[matrix-events] submit falló: ${String(e)}`)
      }
      // If the REPL never leaves idle (a local slash command), do not stay stuck.
      if (submitTimer) clearTimeout(submitTimer)
      submitTimer = setTimeout(() => dispatch({ kind: 'submit_timeout' }), 1500)
      submitTimer.unref?.()
      return
    }
  }
}

/** Handles one parsed message of the input channel. */
export function handleInputMessage(msg: InputMessage): void {
  switch (msg.type) {
    case 'prompt':
      dispatch({ kind: 'prompt', id: msg.id, text: msg.text })
      return
    case 'interrupt':
      dispatch({ kind: 'interrupt' })
      return
    case 'ask_answer':
      answerAsk(msg)
      return
  }
}

/** Parses and handles one raw line; invalid lines are dropped with a debug log. */
export function handleInputLine(line: string): void {
  const parsed = parseInputLine(line)
  if ('reason' in parsed) {
    if (parsed.reason !== 'empty line') {
      logForDebugging(`[matrix-events] línea de entrada descartada (${parsed.reason}): ${line.slice(0, 80)}`)
    }
    return
  }
  try {
    handleInputMessage(parsed.msg)
  } catch (e) {
    logForDebugging(`[matrix-events] error procesando entrada: ${String(e)}`)
  }
}

// ── FIFO reader (FNHARNESS_INPUT) ────────────────────────────────────────

const POLL_MS = 50

/**
 * Non-blocking reader of a FIFO. It opens the FIFO read-write (never blocks on
 * open, never sees EOF while writers come and go) and polls with non-blocking
 * reads. Returns a stop function.
 */
export function startFifoReader(
  path: string,
  onLine: (line: string) => void,
  intervalMs = POLL_MS,
): () => void {
  let fd: number
  try {
    if (!statSync(path).isFIFO()) {
      logForDebugging(`[matrix-events] FNHARNESS_INPUT=${path} no es un FIFO; entrada desactivada`)
      return () => {}
    }
    fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK)
  } catch (e) {
    logForDebugging(`[matrix-events] no se pudo abrir FNHARNESS_INPUT=${path}: ${String(e)}`)
    return () => {}
  }
  const buf = Buffer.alloc(64 * 1024)
  let carry: Uint8Array = new Uint8Array(0)
  const timer = setInterval(() => {
    for (;;) {
      let n: number
      try {
        n = readSync(fd, buf, 0, buf.length, null)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') {
          logForDebugging(`[matrix-events] lectura del FIFO falló: ${String(e)}`)
        }
        return
      }
      if (n <= 0) return
      const drained = drainLines(carry, buf.subarray(0, n))
      carry = drained.carry
      if (drained.overflow) logForDebugging('[matrix-events] línea de entrada demasiado larga; descartada')
      for (const line of drained.lines) onLine(line)
    }
  }, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    try {
      closeSync(fd)
    } catch {}
  }
}

// ── ask_user dialog registry ─────────────────────────────────────────────

type AskState = {
  questions: AskQuestion[]
  answered: boolean
  /** Set by the dialog body while it is mounted; it can remount (Suspense) without ending the dialog. */
  submit: ((answers: Record<string, string>) => void) | null
}

const askDialogs = new Map<string, AskState>()

/** Child effects run before the parent's, so either side may arrive first. */
function askState(toolUseId: string): AskState {
  let state = askDialogs.get(toolUseId)
  if (!state) {
    state = { questions: [], answered: false, submit: null }
    askDialogs.set(toolUseId, state)
  }
  return state
}

/**
 * The permission request for AskUserQuestion appeared: emits `ask_user`. Called
 * from the stable parent of the dialog, so a remount of the dialog body does
 * not repeat the event. Returns the cleanup, which emits `ask_user_done`.
 */
export function announceAskDialog(toolUseId: string, questions: AskQuestion[]): () => void {
  if (!matrixChannelActive()) return () => {}
  askState(toolUseId).questions = questions
  emitMatrix({ type: 'ask_user', tool_use_id: toolUseId, questions })
  return () => {
    const state = askDialogs.get(toolUseId)
    askDialogs.delete(toolUseId)
    emitMatrix({ type: 'ask_user_done', tool_use_id: toolUseId, answered: state?.answered ?? false })
  }
}

/** The dialog body registers how to submit answers; `ask_answer` messages use it. */
export function bindAskSubmit(toolUseId: string, submit: (answers: Record<string, string>) => void): () => void {
  if (!matrixChannelActive()) return () => {}
  const state = askState(toolUseId)
  state.submit = submit
  return () => {
    if (state.submit === submit) state.submit = null
  }
}

/** The dialog was answered (by keyboard or by `ask_answer`). */
export function markAskAnswered(toolUseId: string): void {
  if (matrixChannelActive()) askState(toolUseId).answered = true
}

function answerAsk(msg: Extract<InputMessage, { type: 'ask_answer' }>): void {
  const state = askDialogs.get(msg.tool_use_id)
  if (!state?.submit) {
    logForDebugging(`[matrix-events] ask_answer sin diálogo abierto para ${msg.tool_use_id}`)
    return
  }
  const answers = buildAskAnswers(state.questions, msg)
  if (!answers) {
    logForDebugging(`[matrix-events] ask_answer no encaja con las preguntas de ${msg.tool_use_id}`)
    return
  }
  state.submit(answers)
}

// ── lifecycle hooks used by the REPL and the headless runner ─────────────

/** First call announces `session_start`, installs the exit and session-switch hooks. */
export function matrixSessionStart(args: { resumed: boolean; mcp?: boolean }): void {
  if (initialized || !matrixChannelActive()) return
  initialized = true
  try {
    lastSessionId = String(getSessionId())
    emitMatrix({
      type: 'session_start',
      cwd: getOriginalCwd(),
      account: sessionAccountId(),
      model: getMainLoopModel(),
      resumed: args.resumed,
      pid: process.pid,
      caps: matrixCaps(args.mcp === true),
    })
    for (const body of preInit.splice(0)) emitMatrix(body)
    onSessionSwitch(id => noteSessionChange(String(id), 'resume'))
    process.on('exit', code => {
      // A turn end still waiting for the transcript goes out before `exit`.
      flushTurnEnd()
      emitMatrix({ type: 'exit', code: Number(code ?? process.exitCode ?? 0) })
      cachedSink?.sink.close()
    })
  } catch (e) {
    logForDebugging(`[matrix-events] session_start falló: ${String(e)}`)
  }
}

function noteSessionChange(newId: string, reason: SessionSwitchReason): void {
  if (!initialized || newId === lastSessionId) return
  const old = lastSessionId
  lastSessionId = newId
  emitMatrix({ type: 'session_switch', old_session_id: old, new_session_id: newId, reason })
}

/** Call right after the session id changed on its own (`/clear`). */
export function matrixSessionSwitch(reason: SessionSwitchReason): void {
  if (!matrixChannelActive()) return
  noteSessionChange(String(getSessionId()), reason)
}

/** Wires the REPL actions and starts the FIFO reader. Returns the cleanup. */
export function attachMatrixControls(c: Controls): () => void {
  if (!matrixChannelActive()) return () => {}
  controls = c
  const fifo = process.env.FNHARNESS_INPUT
  const stop = fifo ? startFifoReader(fifo, handleInputLine) : () => {}
  return () => {
    stop()
    if (controls === c) controls = null
  }
}

/** The REPL reports whether the prompt can take input right now. */
export function matrixIdle(idle: boolean): void {
  if (!matrixChannelActive()) return
  dispatch({ kind: 'idle', idle })
}

/**
 * Records where the next turn comes from. Called with the commands the REPL is
 * about to run from its queue: injected ones keep their source, notifications
 * and meta prompts are `scheduled`, anything else typed while busy is `queued`.
 */
export function matrixNoteQueued(commands: readonly QueuedCommand[]): void {
  if (!matrixChannelActive()) return
  for (const cmd of commands) {
    const known = cmd.uuid ? injected.get(cmd.uuid) : undefined
    if (known) {
      injected.delete(cmd.uuid!)
      nextSource = known
      return
    }
  }
  const scheduled = commands.some(c => c.mode === 'task-notification' || c.isMeta === true || c.origin !== undefined)
  nextSource = scheduled ? 'scheduled' : 'queued'
}

/** Capabilities of this process, announced in `session_start.caps` (only what is really emitted). */
export function matrixCaps(mcp: boolean): MatrixCap[] {
  return mcp ? ['entries', 'mcp'] : ['entries']
}

export function matrixTurnStart(): void {
  if (!matrixChannelActive()) return
  // A turn end that is still waiting for the transcript goes out before the next turn begins.
  flushTurnEnd()
  const source = nextSource ?? 'user'
  nextSource = null
  turnStartedAt = Date.now()
  dispatch({ kind: 'turn_start', source })
}

/** The REPL only records a `turn_duration` for turns of 30 s or more. */
const LONG_TURN_MS = 29_000
/** Minimum wait before `turn_end`: lets the REPL's effects hand the last messages to the transcript. */
const TURN_END_MIN_WAIT_MS = 40
const TURN_END_DURATION_WAIT_MS = 1500
const TURN_END_MAX_WAIT_MS = 3000
const TURN_END_POLL_MS = 10

let turnStartedAt = 0
let pendingTurnEnd: { reason: TurnEndReason; timer: ReturnType<typeof setTimeout> | null } | null = null

function flushTurnEnd(): void {
  const pending = pendingTurnEnd
  if (!pending) return
  pendingTurnEnd = null
  if (pending.timer) clearTimeout(pending.timer)
  dispatch({ kind: 'turn_end', reason: pending.reason })
}

/**
 * `turn_end` goes out after the entries of its turn (contract v2): the REPL
 * records messages from an effect, after it already called `matrixTurnEnd`, so
 * the event waits until the recordings in flight finish (and, on a long turn,
 * until its `turn_duration` entry shows up). Without FNHARNESS_EVENTS there are
 * no entries to order and it is emitted at once.
 */
export function matrixTurnEnd(reason: TurnEndReason): void {
  if (!matrixChannelActive()) return
  if (!process.env.FNHARNESS_EVENTS || !initialized) {
    dispatch({ kind: 'turn_end', reason })
    return
  }
  flushTurnEnd()
  const pending: NonNullable<typeof pendingTurnEnd> = { reason, timer: null }
  pendingTurnEnd = pending
  const durationBefore = turnDurationCount
  const expectDuration = reason === 'completed' && Date.now() - turnStartedAt >= LONG_TURN_MS
  const begun = Date.now()
  const poll = () => {
    if (pendingTurnEnd !== pending) return
    const waited = Date.now() - begun
    const durationOk = !expectDuration || turnDurationCount > durationBefore || waited >= TURN_END_DURATION_WAIT_MS
    if ((waited >= TURN_END_MIN_WAIT_MS && recordingsInFlight === 0 && durationOk) || waited >= TURN_END_MAX_WAIT_MS) {
      flushTurnEnd()
      return
    }
    pending.timer = setTimeout(poll, TURN_END_POLL_MS)
    pending.timer.unref?.()
  }
  poll()
}

// ── initial MCP connections (`mcp_settled`) ──────────────────────────────

/** Safety net: if the initial connections never finish, release `ready` anyway. */
const MCP_SETTLE_TIMEOUT_MS = 60_000

let mcpGated = false
let mcpSettledDone = false
let mcpTimer: ReturnType<typeof setTimeout> | null = null
const mcpStates = new Map<string, string>()
const mcpExpected = new Set<string>()

/**
 * The MCP manager starts loading the initial connections. Until
 * `matrixMcpSettled` runs, the channel holds `ready` and queued FIFO prompts, so
 * the bridge does not talk to a model whose MCP tools are not there yet.
 * Idempotent (the manager's effect can run again after `/clear`).
 */
export function matrixMcpBegin(): void {
  if (mcpGated || mcpSettledDone || !matrixChannelActive()) return
  mcpGated = true
  dispatch({ kind: 'mcp_wait', wait: true })
  mcpTimer = setTimeout(settleMcp, MCP_SETTLE_TIMEOUT_MS)
  mcpTimer.unref?.()
}

/** Wraps the manager's connection callback to tally each server's last attempt. */
export function matrixMcpTrack<P extends { client: { name: string; type: string } }>(onAttempt: (p: P) => void) {
  return (p: P): void => {
    if (!mcpSettledDone) mcpStates.set(p.client.name, p.client.type)
    onAttempt(p)
  }
}

/** Servers about to be connected, by name; whatever has no attempt at settle time counts as pending. */
export function matrixMcpExpect(names: Iterable<string>): void {
  if (!mcpGated) return
  for (const n of names) mcpExpected.add(n)
}

/** All the initial connection attempts of a manager run finished. Emits `mcp_settled` once. */
export function matrixMcpSettled(): void {
  settleMcp()
}

function settleMcp(): void {
  if (mcpSettledDone || !mcpGated) return
  mcpSettledDone = true
  if (mcpTimer) clearTimeout(mcpTimer)
  mcpTimer = null
  const tally = tallyMcp(mcpStates, Math.max(mcpExpected.size, mcpStates.size))
  emitMatrix({ type: 'mcp_settled', ...tally })
  dispatch({ kind: 'mcp_wait', wait: false })
}

/**
 * Wraps one headless turn (`-p`): `turn_start` before, `turn_end` after with
 * the reason taken from the outcome. Transparent when the channel is off.
 */
export async function matrixTrackTurn<T>(wasAborted: () => boolean, run: () => Promise<T>): Promise<T> {
  matrixTurnStart()
  let reason: TurnEndReason = 'completed'
  try {
    return await run()
  } catch (e) {
    reason = 'error'
    throw e
  } finally {
    matrixTurnEnd(wasAborted() ? 'interrupted' : reason)
  }
}

/** Test hook: forget all module state. */
export function resetMatrixRuntimeForTesting(): void {
  cachedSink?.sink.close()
  cachedSink = null
  flow = initialFlow
  controls = null
  nextSource = null
  injected.clear()
  inputIds.clear()
  preInit.length = 0
  turnDurationCount = 0
  recordingsInFlight = 0
  if (pendingTurnEnd?.timer) clearTimeout(pendingTurnEnd.timer)
  pendingTurnEnd = null
  turnStartedAt = 0
  if (mcpTimer) clearTimeout(mcpTimer)
  mcpTimer = null
  mcpGated = false
  mcpSettledDone = false
  mcpStates.clear()
  mcpExpected.clear()
  askDialogs.clear()
  initialized = false
  lastSessionId = ''
  if (submitTimer) clearTimeout(submitTimer)
  submitTimer = null
}

/**
 * `--fork-session` starts a new session that must not write into the event
 * file nor read the input FIFO of the session it came from: drop both
 * variables from the environment of the new process. Returns true if any was set.
 */
export function matrixDropChannelsForFork(env: NodeJS.ProcessEnv = process.env): boolean {
  const had = Boolean(env.FNHARNESS_EVENTS || env.FNHARNESS_INPUT)
  delete env.FNHARNESS_EVENTS
  delete env.FNHARNESS_INPUT
  return had
}
