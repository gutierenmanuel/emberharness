/**
 * Native listening mode, step 4: the assistant's SPOKEN OUTPUT.
 *
 * Only while native listening is on (FNHARNESS_VOICE_LISTEN=1): when the main
 * transcript records an assistant entry, the first paragraph of each text
 * block is read aloud through the speech queue (`enqueue_speech.py`, priority
 * `respuesta`). Code, tables and long paths are never spoken, and the text is
 * cut to MAX_SPOKEN_CHARS at a sentence boundary. The queue server also
 * sanitises markdown (`prepare_text_for_speech`), so the filtering here is
 * only the obvious part.
 *
 * - Barge-in: when the voice child reports `speech_start`, `--cancel` cuts
 *   what is playing and empties the queue (registered through
 *   `setSpeechStartHandler`, see `installVoiceSpeak`).
 * - Anti-echo: after queueing each utterance, `noteSpoken(text)` tells the
 *   listener what the assistant is saying so it does not hear itself.
 *
 * v1 hooks the transcript write (whole text block, one call per block, no
 * duplicates thanks to the entry uuid). v2 = sentence-by-sentence streaming
 * from `src/services/api/claude.ts` ~line 2110, speaking while the model
 * still writes.
 *
 * Privacy: what is spoken is never logged from here, only lengths.
 */

import { spawn as nodeSpawn } from 'child_process'
import { openSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { noteSpoken as realNoteSpoken, setSpeechStartHandler, voiceListenEnabled } from './voiceListenRuntime.js'

const PY = '/home/user/fn_registry/python/.venv/bin/python3'
const INFRA = '/home/user/fn_registry/python/functions/infra'
export const ENQUEUE_SPEECH_ARGV = [PY, `${INFRA}/enqueue_speech.py`]
export const SERVE_SPEECH_ARGV = [PY, '-u', `${INFRA}/serve_speech_queue.py`]

/** Spoken text never exceeds this many characters. */
export const MAX_SPOKEN_CHARS = 240

/** System prompt rule appended in voice mode (see main.tsx). */
export const VOICE_SPEAK_PROMPT =
  'Tu primer párrafo se lee en voz alta: máximo 2 frases, claro y sin rutas, código ni tablas; el detalle va después, solo escrito. Si necesitas herramientas o pensar, empieza por un acuse de una frase («Voy», «Mirando») y habla el resultado al terminar.'

// ── pure helpers ─────────────────────────────────────────────────────────

const PATHISH = /(?:^|[\s(])(?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]*)+/g
const URLISH = /\bhttps?:\/\/\S+/g

/** Cuts at the last sentence end that fits, else at a word boundary. */
export function clipToSentences(text: string, max: number = MAX_SPOKEN_CHARS): string {
  if (text.length <= max) return text
  const sentences = text.match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/g) ?? [text]
  let out = ''
  for (const s of sentences) {
    if ((out + s).trim().length > max) break
    out += s
  }
  out = out.trim()
  if (out) return out
  const cut = text.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim()
}

/**
 * The text to say for one assistant text block, or null when there is
 * nothing speakable: only the first paragraph, never code or tables, with
 * inline code, URLs and paths removed.
 */
export function pickSpokenText(block: string): string | null {
  const first = block
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)[0]
    ?.trim()
  if (!first) return null
  if (/^(```|~~~)/.test(first)) return null // code block
  if (first.split('\n').filter(l => l.trim().startsWith('|')).length >= 2) return null // table
  if (/^( {4}|\t)\S/.test(first)) return null // indented code
  const clean = first
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(URLISH, ' ')
    .replace(PATHISH, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.replace(/[^\p{L}]/gu, '').length < 2) return null
  return clipToSentences(clean)
}

type ContentBlock = { type?: string; text?: unknown }

/** Text blocks of a main-transcript entry, only when it is an assistant entry of the main thread. */
export function assistantTextBlocks(entry: Record<string, unknown>): string[] {
  if (entry.type !== 'assistant' || entry.isSidechain || entry.isMeta || entry.isApiErrorMessage) return []
  const content = (entry.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as ContentBlock[])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
}

// ── speaker ──────────────────────────────────────────────────────────────

export type SpeechQueue = {
  /** Queues one utterance (priority `respuesta`). Resolves when handed over; never rejects. */
  say: (text: string) => Promise<void> | void
  /** Barge-in: cuts what plays and empties the queue. */
  cancel: () => Promise<void> | void
}

export type VoiceSpeakerOptions = {
  queue?: SpeechQueue
  noteSpoken?: (text: string) => boolean
  enabled?: () => boolean
  log?: (msg: string) => void
}

export type VoiceSpeaker = {
  /** Offers a transcript entry; speaks its first paragraph(s) if it qualifies. Returns utterances queued. */
  onEntry: (entry: Record<string, unknown>) => number
  /** Barge-in. */
  bargeIn: () => void
}

export function createVoiceSpeaker(opts: VoiceSpeakerOptions = {}): VoiceSpeaker {
  const queue = opts.queue ?? createProcessQueue()
  const noteSpoken = opts.noteSpoken ?? realNoteSpoken
  const enabled = opts.enabled ?? voiceListenEnabled
  const log = opts.log ?? logForDebugging
  const seen = new Set<string>()
  let generation = 0

  return {
    onEntry(entry) {
      if (!enabled()) return 0
      const blocks = assistantTextBlocks(entry)
      if (blocks.length === 0) return 0
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : ''
      if (uuid) {
        if (seen.has(uuid)) return 0
        seen.add(uuid)
        if (seen.size > 500) seen.delete(seen.values().next().value as string)
      }
      let n = 0
      for (const b of blocks) {
        const text = pickSpokenText(b)
        if (!text) continue
        n += 1
        const gen = generation
        void Promise.resolve(queue.say(text))
          .catch(() => {})
          .then(() => {
            // A barge-in between the queueing and the hand-over already cut it.
            if (gen === generation) noteSpoken(text)
          })
        log(`[voice-speak] locución (${text.length} car.)`)
      }
      return n
    },
    bargeIn() {
      if (!enabled()) return
      generation += 1
      void Promise.resolve(queue.cancel()).catch(() => {})
      log('[voice-speak] barge-in')
    },
  }
}

// ── real queue: child processes, never blocking the REPL ─────────────────

type SpawnFn = typeof nodeSpawn

/** Runs argv to completion, resolving with its exit code (-1 if it cannot start). */
function run(spawnFn: SpawnFn, argv: string[]): Promise<number> {
  return new Promise(resolve => {
    try {
      const c = spawnFn(argv[0]!, argv.slice(1), { stdio: 'ignore' })
      c.on('error', () => resolve(-1))
      c.on('exit', code => resolve(code ?? -1))
      c.unref?.()
    } catch {
      resolve(-1)
    }
  })
}

/**
 * Queue backed by `enqueue_speech.py`. On the first utterance it checks
 * `--status` and, if the queue server is not alive, starts
 * `serve_speech_queue.py` detached (log in tmpdir). Says are chained so they
 * keep their order; cancels go straight through.
 */
export function createProcessQueue(spawnFn: SpawnFn = nodeSpawn): SpeechQueue {
  let alive: Promise<void> | null = null
  let chain: Promise<void> = Promise.resolve()

  const ensureAlive = (): Promise<void> => {
    alive ??= (async () => {
      if ((await run(spawnFn, [...ENQUEUE_SPEECH_ARGV, '--status'])) === 0) return
      try {
        const out = openSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'fnharness-voz-cola.log'), 'a', 0o600)
        const c = spawnFn(SERVE_SPEECH_ARGV[0]!, SERVE_SPEECH_ARGV.slice(1), {
          stdio: ['ignore', out, out],
          detached: true,
        })
        c.on('error', () => {})
        c.unref()
      } catch {}
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300))
        if ((await run(spawnFn, [...ENQUEUE_SPEECH_ARGV, '--status'])) === 0) return
      }
    })()
    return alive
  }

  return {
    say(text) {
      const job = chain.then(async () => {
        await ensureAlive()
        await run(spawnFn, [...ENQUEUE_SPEECH_ARGV, '--prioridad', 'respuesta', '--', text])
      })
      chain = job.catch(() => {})
      return job
    },
    cancel() {
      return run(spawnFn, [...ENQUEUE_SPEECH_ARGV, '--cancel']).then(() => {})
    },
  }
}

// ── process-wide instance ────────────────────────────────────────────────

let instance: VoiceSpeaker | null = null

function speaker(): VoiceSpeaker {
  return (instance ??= createVoiceSpeaker())
}

/** Called by the transcript writer for every main-thread entry; no-op without the flag. */
export function voiceSpeakEntry(entry: Record<string, unknown>): void {
  if (!voiceListenEnabled()) return
  try {
    speaker().onEntry(entry)
  } catch (e) {
    logForDebugging(`[voice-speak] error: ${(e as Error).name}`)
  }
}

/** Hooks barge-in to the listener's `speech_start`. Returns the uninstall function. */
export function installVoiceSpeak(): () => void {
  setSpeechStartHandler(() => speaker().bargeIn())
  return () => setSpeechStartHandler(undefined)
}
