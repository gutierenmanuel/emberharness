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
  type AskQuestion,
  type EventBody,
  type FlowAction,
  type FlowEvent,
  type FlowState,
  type InputMessage,
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
  if (!initialized && body.type !== 'session_start') return
  try {
    currentSink()?.emit(body)
  } catch {}
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
export function matrixSessionStart(args: { resumed: boolean }): void {
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
    })
    onSessionSwitch(id => noteSessionChange(String(id), 'resume'))
    process.on('exit', code => {
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

export function matrixTurnStart(): void {
  if (!matrixChannelActive()) return
  const source = nextSource ?? 'user'
  nextSource = null
  dispatch({ kind: 'turn_start', source })
}

export function matrixTurnEnd(reason: TurnEndReason): void {
  if (!matrixChannelActive()) return
  dispatch({ kind: 'turn_end', reason })
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
  askDialogs.clear()
  initialized = false
  lastSessionId = ''
  if (submitTimer) clearTimeout(submitTimer)
  submitTimer = null
}
