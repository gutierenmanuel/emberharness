/**
 * Native listening mode, step 2: the person's voice enters the session as a
 * normal user message with origin `voice`.
 *
 * A Python child process (`stream_voice_dictation.py`) does the audio work and
 * prints JSONL on stdout, one JSON object per line:
 *
 *   {"type":"ready"}
 *   {"type":"speech_start","mic":"omi","t0":...}
 *   {"type":"utterance","text":"...","mic":"omi","t0":...,"t1":...,"fragments":3}
 *
 * and accepts `{"spoken":"text"}\n` on stdin (anti-echo: what the assistant
 * says aloud). This module spawns it, parses its output tolerantly, restarts
 * it with backoff when it dies and enqueues every utterance in the command
 * queue. Only one fnharness session at a time listens (lock file with PID).
 *
 * Off unless FNHARNESS_VOICE_LISTEN=1 (the REPL hook decides). Privacy: what
 * is said is never written to a log from here, only counters and lengths.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { logForDebugging } from './debug.js'
import { enqueue as realEnqueue } from './messageQueueManager.js'
import { sanitizeMic, type VoiceOrigin } from './voiceOrigin.js'

export const DEFAULT_VOICE_CMD =
  '/home/user/fn_registry/python/.venv/bin/python3 -u /home/user/fn_registry/python/functions/pipelines/stream_voice_dictation.py'

/** Hard cap on one utterance: anything longer is a runaway producer, not speech. */
export const MAX_UTTERANCE_CHARS = 8000

// ── pure helpers ─────────────────────────────────────────────────────────

export type VoiceEvent =
  | { type: 'ready' }
  | { type: 'speech_start'; mic: string; t0?: number }
  | { type: 'utterance'; text: string; mic: string; t0?: number; t1?: number; fragments?: number }

/** One stdout line → event, or null for anything that is not a well-formed event (never throws). */
export function parseVoiceLine(line: string): VoiceEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let o: unknown
  try {
    o = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  switch (r.type) {
    case 'ready':
      return { type: 'ready' }
    case 'speech_start':
      return { type: 'speech_start', mic: sanitizeMic(r.mic), t0: num(r.t0) }
    case 'utterance': {
      if (typeof r.text !== 'string') return null
      const text = r.text.trim().slice(0, MAX_UTTERANCE_CHARS)
      if (!text) return null
      return {
        type: 'utterance',
        text,
        mic: sanitizeMic(r.mic),
        t0: num(r.t0),
        t1: num(r.t1),
        fragments: num(r.fragments),
      }
    }
    default:
      return null
  }
}

/** The queued command for one utterance: a normal prompt of the person (never meta). */
export function buildVoiceCommand(text: string, mic: string): QueuedCommand {
  const origin: VoiceOrigin = { kind: 'voice', mic: sanitizeMic(mic) }
  return {
    mode: 'prompt',
    value: text,
    priority: 'next',
    origin,
    skipSlashCommands: true,
  } as QueuedCommand
}

/** Splits a command line into argv: whitespace separated, single/double quotes group. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

/** Restart delay: 1 s, 2 s, 4 s ... capped at 30 s. */
export function defaultBackoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1))
}

export function defaultLockPath(): string {
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'fnharness-voice.lock')
}

// ── lock (only one session listens) ──────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type VoiceLock = { release: () => void }

/**
 * Takes the lock file, writing our PID. A lock whose PID is dead is stale and
 * is recovered. Returns null when a live process (this one included) holds it.
 */
export function acquireVoiceLock(path: string, pid: number = process.pid): VoiceLock | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, String(pid))
      } finally {
        closeSync(fd)
      }
      return {
        release() {
          try {
            if (Number.parseInt(readFileSync(path, 'utf8'), 10) === pid) unlinkSync(path)
          } catch {}
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
    }
    let holder = NaN
    try {
      holder = Number.parseInt(readFileSync(path, 'utf8'), 10)
    } catch {
      continue // vanished between the open and the read: try again
    }
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return null
    try {
      unlinkSync(path) // stale (dead PID or garbage): recover it
    } catch {}
  }
  return null
}

// ── listener ─────────────────────────────────────────────────────────────

export type VoiceListenOptions = {
  /** Command line of the child; default FNHARNESS_VOICE_CMD or DEFAULT_VOICE_CMD. */
  cmd?: string
  lockPath?: string
  enqueue?: (cmd: QueuedCommand) => void
  onSpeechStart?: (e: { mic: string; t0?: number }) => void
  /** Called after the command was enqueued (e.g. to wake the queue processor). */
  onUtterance?: (e: { mic: string; chars: number }) => void
  spawn?: typeof nodeSpawn
  backoff?: (attempt: number) => number
  /** A child alive this long resets the backoff. */
  stableMs?: number
  /** Logger; receives counters only, never what was said. */
  log?: (msg: string) => void
}

export type VoiceStatus = {
  running: boolean
  ready: boolean
  pid: number | null
  restarts: number
  utterances: number
  lockHeld: boolean
  /** Between `speech_start` and the next `utterance`: the person is talking. */
  speaking: boolean
  /** Mic and time (epoch ms) of the last utterance. Never what was said. */
  lastMic: string | null
  lastAt: number | null
}

/** The `voice` block of the status bar: microphone state, never text. */
export type VoiceStatusJson = {
  listening: boolean
  speaking: boolean
  last: { mic: string; at: number } | null
}

export function voiceStatusJson(s: VoiceStatus): VoiceStatusJson {
  return {
    listening: s.running && s.ready,
    speaking: s.speaking,
    last: s.lastMic !== null && s.lastAt !== null ? { mic: s.lastMic, at: s.lastAt } : null,
  }
}

const IDLE_STATUS: VoiceStatus = {
  running: false,
  ready: false,
  pid: null,
  restarts: 0,
  utterances: 0,
  lockHeld: false,
  speaking: false,
  lastMic: null,
  lastAt: null,
}

export type VoiceStartResult = { started: true } | { started: false; reason: 'locked' | 'already_running' | 'empty_cmd' }

export type VoiceListener = {
  start: () => VoiceStartResult
  stop: () => void
  status: () => VoiceStatus
  noteSpoken: (text: string) => boolean
}

export function createVoiceListener(opts: VoiceListenOptions = {}): VoiceListener {
  const log = opts.log ?? logForDebugging
  const enqueueFn = opts.enqueue ?? realEnqueue
  const spawnFn = opts.spawn ?? nodeSpawn
  const backoff = opts.backoff ?? defaultBackoff
  const stableMs = opts.stableMs ?? 10_000
  const lockPath = opts.lockPath ?? defaultLockPath()

  let lock: VoiceLock | null = null
  let child: ChildProcess | null = null
  let running = false
  let ready = false
  let restarts = 0
  let utterances = 0
  let speaking = false
  let lastMic: string | null = null
  let lastAt: number | null = null
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let startedAt = 0

  function handleLine(line: string): void {
    const ev = parseVoiceLine(line)
    if (!ev) return
    try {
      if (ev.type === 'ready') {
        ready = true
        log('[voice] hijo listo')
      } else if (ev.type === 'speech_start') {
        speaking = true
        opts.onSpeechStart?.({ mic: ev.mic, t0: ev.t0 })
      } else {
        utterances += 1
        speaking = false
        lastMic = ev.mic
        lastAt = Date.now()
        enqueueFn(buildVoiceCommand(ev.text, ev.mic))
        log(`[voice] frase #${utterances} (${ev.text.length} car.)`)
        opts.onUtterance?.({ mic: ev.mic, chars: ev.text.length })
      }
    } catch (e) {
      log(`[voice] error procesando evento: ${(e as Error).name}`)
    }
  }

  function launch(): void {
    timer = null
    if (!running) return
    const argv = splitCommand(opts.cmd ?? process.env.FNHARNESS_VOICE_CMD ?? DEFAULT_VOICE_CMD)
    let c: ChildProcess
    try {
      c = spawnFn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      log(`[voice] no se pudo lanzar el hijo: ${(e as Error).name}`)
      scheduleRestart()
      return
    }
    child = c
    ready = false
    speaking = false
    startedAt = Date.now()
    let dead = false
    const onDeath = (why: string) => {
      if (dead) return
      dead = true
      if (child === c) child = null
      ready = false
      speaking = false
      log(`[voice] hijo terminado (${why})`)
      if (running) scheduleRestart()
    }
    c.stdin?.on('error', () => {})
    if (c.stdout) {
      const rl = createInterface({ input: c.stdout })
      rl.on('line', handleLine)
    }
    c.on('error', e => onDeath(`error ${(e as NodeJS.ErrnoException).code ?? 'desconocido'}`))
    c.on('exit', code => onDeath(`exit ${code}`))
  }

  function scheduleRestart(): void {
    if (!running || timer) return
    if (Date.now() - startedAt >= stableMs) attempt = 0
    attempt += 1
    restarts += 1
    const delay = backoff(attempt)
    log(`[voice] reintento #${restarts} en ${delay} ms`)
    timer = setTimeout(launch, delay)
    timer.unref?.()
  }

  return {
    start() {
      if (running) return { started: false, reason: 'already_running' }
      if (splitCommand(opts.cmd ?? process.env.FNHARNESS_VOICE_CMD ?? DEFAULT_VOICE_CMD).length === 0) {
        return { started: false, reason: 'empty_cmd' }
      }
      lock = acquireVoiceLock(lockPath)
      if (!lock) {
        log('[voice] otra sesión ya escucha (lock tomado)')
        return { started: false, reason: 'locked' }
      }
      running = true
      attempt = 0
      launch()
      return { started: true }
    },
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      const c = child
      child = null
      ready = false
      speaking = false
      try {
        c?.kill('SIGTERM')
      } catch {}
      lock?.release()
      lock = null
    },
    status() {
      return {
        running,
        ready,
        pid: child?.pid ?? null,
        restarts,
        utterances,
        lockHeld: lock !== null,
        speaking,
        lastMic,
        lastAt,
      }
    },
    noteSpoken(text) {
      const stdin = child?.stdin
      if (!stdin || stdin.destroyed || !stdin.writable) return false
      try {
        stdin.write(JSON.stringify({ spoken: text }) + '\n')
        return true
      } catch {
        return false
      }
    },
  }
}

// ── process-wide instance ────────────────────────────────────────────────

let active: VoiceListener | null = null
let speechStartHandler: ((e: { mic: string; t0?: number }) => void) | undefined

export function voiceListenEnabled(): boolean {
  return process.env.FNHARNESS_VOICE_LISTEN === '1'
}

/** Registers the (future) barge-in hook; called on every `speech_start`. */
export function setSpeechStartHandler(fn: ((e: { mic: string; t0?: number }) => void) | undefined): void {
  speechStartHandler = fn
}

export function startVoiceListen(opts: VoiceListenOptions = {}): VoiceStartResult {
  if (active?.status().running) return { started: false, reason: 'already_running' }
  active = createVoiceListener({ onSpeechStart: e => speechStartHandler?.(e), ...opts })
  const r = active.start()
  if (!r.started) active = null
  return r
}

export function stopVoiceListen(): void {
  active?.stop()
  active = null
}

export function voiceListenStatus(): VoiceStatus {
  return active?.status() ?? IDLE_STATUS
}

/** Tells the child what the assistant said aloud (anti-echo). False when nothing is listening. */
export function noteSpoken(text: string): boolean {
  return active?.noteSpoken(text) ?? false
}
