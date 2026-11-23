/**
 * Native listening mode, step 4: the assistant's SPOKEN OUTPUT.
 *
 * Only while native listening is on (a listener running in this process): when the main
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
 * - Anti-echo: after queueing each utterance or chunk, `noteSpoken(text)`
 *   tells the listener what the assistant is saying so it does not hear
 *   itself. The listener (`stream_voice_dictation.py`) keeps discarding it
 *   until 2 s after the speech queue reports that it stopped speaking.
 *
 * Streaming (v2): `src/services/api/claude.ts` feeds every `text_delta` of
 * the main thread to `voiceSpeakDelta`, so the voice starts while the model
 * still writes. `takeSpokenChunks` cuts the first chunk at the first closed
 * sentence, or at a natural pause (comma, semicolon, conjunction) once it has
 * FIRST_CHUNK_MIN_WORDS words, never inside a word, a number, inline code or a link, and then
 * sentence by sentence. All the chunks of one text block go to the queue as
 * one stream (`--stream <msg>:<index>`, `--fin` on the last one), so voz_lab
 * synthesises the next chunk while the current one plays and there is no gap.
 * The transcript hook (v1) stays as the fallback for messages that did not
 * stream; a message that streamed is never spoken twice.
 *
 * Who is answered (`hablar` in ~/.config/fnharness/voces.json): "preguntas"
 * (default) speaks only when the last human message of the transcript came by
 * voice AND asks for an answer (`wantsSpokenReply`); "siempre" speaks every
 * answer; "nunca" never. The decision is per turn: every human user entry of
 * the main transcript (voice origin or keyboard) renews it, so a message typed
 * after a voice one revokes the permission.
 *
 * Which voice says it (alias -> voice, naming the session) is resolved by
 * `enqueue_speech.py`: this module only passes `--pid <pid>` (always) and `--alias <alias>` (when known).
 *
 * Privacy: what is spoken is never logged from here, only lengths.
 */

import { spawn as nodeSpawn } from 'child_process'
import { openSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getSessionId } from '../bootstrap/state.js'
import { getOwnSessionAlias } from './peerAlias.js'
import { isVoiceOrigin, unwrapVoiceText } from './voiceOrigin.js'
import { noteSpoken as realNoteSpoken, setSpeechStartHandler, setStopHandler, voiceListenActive } from './voiceListenRuntime.js'

const REGISTRY_ROOT = process.env.FN_REGISTRY_ROOT ?? join(homedir(), 'fn_registry')
const PY = join(REGISTRY_ROOT, 'python/.venv/bin/python3')
const INFRA = join(REGISTRY_ROOT, 'python/functions/infra')
export const ENQUEUE_SPEECH_ARGV = [PY, `${INFRA}/enqueue_speech.py`]
export const SERVE_SPEECH_ARGV = [PY, '-u', `${INFRA}/serve_speech_queue.py`]

/** Spoken text never exceeds this many characters. */
export const MAX_SPOKEN_CHARS = 240

/** System prompt rule appended in voice mode (see main.tsx). */
export const VOICE_SPEAK_PROMPT =
  'Tu primer párrafo se lee en voz alta: máximo 2 frases, claro y sin rutas, código ni tablas; el detalle va después, solo escrito. Si necesitas herramientas o pensar, empieza por un acuse de una frase («Voy», «Mirando») y habla el resultado al terminar. Ante un mensaje de voz nuevo de la persona, contesta primero con una frase corta y deja lo largo en segundo plano (agentes o comandos en background) para poder seguir oyéndola mientras trabajas.'

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

/** Inline markdown, code, URLs and paths out; whitespace collapsed. */
export function cleanSpokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(URLISH, ' ')
    .replace(PATHISH, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const hasLetters = (t: string) => t.replace(/[^\p{L}]/gu, '').length >= 2

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
  const clean = cleanSpokenText(first)
  if (!hasLetters(clean)) return null
  return clipToSentences(clean)
}

// ── who is answered (pure + config) ──────────────────────────────────────

/** `hablar` key of voces.json: when this session may speak its answers. */
export type SpeakMode = 'preguntas' | 'siempre' | 'nunca'

export const DEFAULT_SPEAK_MODE: SpeakMode = 'preguntas'

export function defaultVocesPath(): string {
  return join(homedir(), '.config', 'fnharness', 'voces.json')
}

/**
 * Reads only the `hablar` key of voces.json. Tolerant: a missing file, bad
 * JSON or an unknown value gives the default ("preguntas"). The other keys
 * (principal, voces, decir_nombre) belong to the speech queue, not to this module.
 */
export function readSpeakMode(path: string = defaultVocesPath()): SpeakMode {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const v = o && typeof o === 'object' ? (o as Record<string, unknown>).hablar : undefined
    if (typeof v === 'string') {
      const k = v.trim().toLowerCase()
      if (k === 'preguntas' || k === 'siempre' || k === 'nunca') return k
    }
  } catch {}
  return DEFAULT_SPEAK_MODE
}

const L = '\\p{L}'
// Interrogatives: with accent anywhere; without accent only at the start of a sentence
// ("que" inside a sentence is almost always a relative, not a question).
const ACCENTED_Q = new RegExp(
  `(?<![${L}])(?:qué|cómo|cuándo|dónde|cuál(?:es)?|cuánt[oa]s?|quién(?:es)?|por qué)(?![${L}])`,
  'u',
)
const PLAIN_Q_AT_START = new RegExp(
  `(?:^|[.!?…¿]\\s*)(?:que|como|cuando|donde|cual(?:es)?|cuant[oa]s?|quien(?:es)?|por que)(?![${L}])`,
  'u',
)
const REQUEST_VERB = new RegExp(
  `(?<![${L}])(?:dime|cuéntame|cuentame|explícame|explicame|confírmame|confirmame|avísame|avisame)(?![${L}])`,
  'u',
)

/**
 * True when the person's message asks for an answer: a question mark («?» or «¿»),
 * an interrogative word (qué, cómo, cuándo, dónde, por qué, cuál, cuánto/a, quién;
 * unaccented only at the start of a sentence) or a request verb (dime, cuéntame,
 * explícame, confírmame, avísame). Case and accents on the verbs do not matter.
 */
export function wantsSpokenReply(text: string): boolean {
  if (!text) return false
  if (/[?¿]/.test(text)) return true
  const t = text.toLowerCase()
  return ACCENTED_Q.test(t) || PLAIN_Q_AT_START.test(t) || REQUEST_VERB.test(t)
}

type UserTurn = { origin: 'voice' | 'keyboard'; text: string }

/**
 * The human message a transcript entry carries, or null when the entry is not one
 * (assistant, tool results, meta/system injections, other origins such as peers,
 * channels or task notifications, compact summaries).
 */
export function humanUserTurn(entry: Record<string, unknown>): UserTurn | null {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null
  const origin = entry.origin as { kind?: unknown } | undefined
  const voice = isVoiceOrigin(origin)
  if (origin !== undefined && !voice && origin?.kind !== 'human') return null
  const content = (entry.message as { content?: unknown } | undefined)?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = (content as ContentBlock[])
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
  }
  text = text.trim()
  if (!text || text.startsWith('<system-reminder>')) return null
  return { origin: voice ? 'voice' : 'keyboard', text: voice ? unwrapVoiceText(text) : text }
}

// ── streaming chunker (pure) ─────────────────────────────────────────────

/**
 * Words the first chunk needs before a soft pause (comma, conjunction) may
 * cut it. Measured with Reverb (voz_lab): it synthesises every chunk without
 * context, and chunks of 4-6 words come out flat (pitch deviation ~19 Hz vs
 * about double for a whole sentence) because each chunk restarts the rhythm.
 * So a soft cut needs ~8 words; a closed sentence goes out at any length
 * (short acks like «Voy.» or «Mirando.» are whole sentences).
 */
export const FIRST_CHUNK_MIN_WORDS = 8

export type SpokenStreamState = {
  /** Raw text of the block received so far. */
  raw: string
  /** Offset in `raw` up to which text was already turned into chunks. */
  upTo: number
  /** Characters already spoken (cap MAX_SPOKEN_CHARS). */
  spoken: number
  /** Chunks emitted so far. */
  chunks: number
  /** Nothing more will be spoken for this block (paragraph over, cap, code, barge-in). */
  done: boolean
}

export function newSpokenStream(): SpokenStreamState {
  return { raw: '', upTo: 0, spoken: 0, chunks: 0, done: false }
}

const ABBREV = new Set(['p', 'ej', 'etc', 'sr', 'sra', 'dr', 'dra', 'vs', 'pág', 'núm', 'aprox', 'ud', 'uds'])
const CONJ = /\s(?=(?:y|e|o|u|pero|porque|aunque|que|pues|así que|mientras|cuando|si|and|but|so|because)\s)/giu
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length

/** True when `pos` of `text` falls inside inline code or a markdown link. */
function insideMarkup(text: string, pos: number): boolean {
  const before = text.slice(0, pos)
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return true
  const lb = before.lastIndexOf('[')
  if (lb > before.lastIndexOf(']')) return true
  const lp = before.lastIndexOf('](')
  return lp >= 0 && before.indexOf(')', lp) < 0
}

/** Cut positions (exclusive end of a chunk) in `region`, in order. `soft` = only valid for the first chunk. */
function cutPoints(region: string): Array<{ at: number; soft: boolean }> {
  const out: Array<{ at: number; soft: boolean }> = []
  for (const m of region.matchAll(/[.!?…:;](?=\s)|\n/g)) {
    const i = m.index!
    if (m[0] === '.') {
      const w = /([\p{L}]+)$/u.exec(region.slice(0, i))?.[1]?.toLowerCase()
      if (w && (w.length === 1 || ABBREV.has(w))) continue // abbreviation, not a sentence end
    }
    out.push({ at: i + 1, soft: m[0] === ';' || m[0] === ':' })
  }
  for (const m of region.matchAll(/,(?=\s)/g)) {
    const i = m.index!
    // never between numbers ("1, 2 y 3")
    if (/\d$/.test(region.slice(0, i)) || /^\s*\d/.test(region.slice(i + 1))) continue
    out.push({ at: i + 1, soft: true })
  }
  for (const m of region.matchAll(CONJ)) {
    if (/\d$/.test(region.slice(0, m.index!))) continue
    out.push({ at: m.index!, soft: true })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * Feeds the stream state and returns the chunks ready to speak. `final` =
 * the block ended: whatever is left of the first paragraph goes out.
 * Mutates `st`.
 */
export function takeSpokenChunks(st: SpokenStreamState, final: boolean): string[] {
  if (st.done) return []
  const raw = st.raw.replace(/\r/g, '')
  const lead = raw.trimStart()
  if (st.chunks === 0 && st.upTo === 0) {
    if (!final && lead.length < 3) return []
    // code, tables and indented code are never spoken
    if (/^(```|~~~|\|)/.test(lead) || /^(?: {4}|\t)\S/.test(raw.replace(/^\n+/, ''))) {
      st.done = true
      return []
    }
  }
  const leadOff = raw.length - lead.length
  const para = /\n\s*\n/.exec(raw.slice(leadOff))
  const end = para ? leadOff + para.index : raw.length
  const closing = final || para !== null
  const out: string[] = []

  const emit = (segment: string): boolean => {
    const clean = cleanSpokenText(segment)
    if (!hasLetters(clean)) return true
    const room = MAX_SPOKEN_CHARS - st.spoken
    let text = clean
    if (text.length > room) {
      text = room > 0 ? clipToSentences(text, room) : ''
      st.done = true
    }
    if (text && hasLetters(text)) {
      out.push(text)
      st.spoken += text.length + 1
      st.chunks += 1
    }
    return !st.done
  }

  while (!st.done) {
    const region = raw.slice(st.upTo, end)
    const first = st.chunks === 0
    const cut = cutPoints(region).find(
      c =>
        !insideMarkup(raw, st.upTo + c.at) &&
        (c.soft ? first && words(region.slice(0, c.at)) >= FIRST_CHUNK_MIN_WORDS : words(region.slice(0, c.at)) >= 1),
    )
    if (!cut) break
    const ok = emit(region.slice(0, cut.at))
    st.upTo += cut.at
    if (!ok) break
  }
  if (!st.done && closing) {
    emit(raw.slice(st.upTo, end))
    st.upTo = end
    st.done = true
  }
  return out
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

export type SayOptions = {
  /** Stream id: chunks with the same id are spoken as one utterance, without gaps. */
  stream?: string
  /** Last chunk of the stream (with empty text it only closes it). */
  fin?: boolean
}

export type SpeechQueue = {
  /** Queues one utterance (priority `respuesta`). Resolves when handed over; never rejects. */
  say: (text: string, opts?: SayOptions) => Promise<void> | void
  /** Barge-in: cuts what plays and empties the queue. */
  cancel: () => Promise<void> | void
}

export type VoiceSpeakerOptions = {
  queue?: SpeechQueue
  noteSpoken?: (text: string) => boolean
  enabled?: () => boolean
  /** Speak mode (`hablar`); default reads voces.json (cached for a couple of seconds). */
  mode?: () => SpeakMode
  log?: (msg: string) => void
}

export type VoiceSpeaker = {
  /** Offers a transcript entry; speaks its first paragraph(s) if it qualifies. Returns utterances queued. */
  onEntry: (entry: Record<string, unknown>) => number
  /** Streaming: a text delta of block `index` of message `msgId`. Returns chunks queued. */
  onDelta: (msgId: string, index: number, text: string) => number
  /** Streaming: block `index` of `msgId` ended; the rest of its first paragraph goes out. Returns chunks queued. */
  onBlockEnd: (msgId: string, index: number) => number
  /** Barge-in. */
  bargeIn: () => void
}

/** `readSpeakMode` with a short cache: the delta hook asks on every block, the file is read rarely. */
function cachedSpeakMode(ttlMs = 2000): () => SpeakMode {
  let at = 0
  let value: SpeakMode = DEFAULT_SPEAK_MODE
  return () => {
    const now = Date.now()
    if (now - at >= ttlMs) {
      value = readSpeakMode()
      at = now
    }
    return value
  }
}

export function createVoiceSpeaker(opts: VoiceSpeakerOptions = {}): VoiceSpeaker {
  const queue = opts.queue ?? createProcessQueue()
  const noteSpoken = opts.noteSpoken ?? realNoteSpoken
  const enabled = opts.enabled ?? voiceListenActive
  const log = opts.log ?? logForDebugging
  const mode = opts.mode ?? cachedSpeakMode()
  /** The last human message of the transcript came by voice and asks for an answer. */
  let voicePermit = false
  const allowed = (): boolean => {
    const m = mode()
    return m === 'siempre' || (m === 'preguntas' && voicePermit)
  }
  const seen = new Set<string>()
  /** Message ids that streamed: the transcript hook must not speak them again. */
  const streamed = new Set<string>()
  const streams = new Map<string, { st: SpokenStreamState; sent: number }>()
  /** Blocks that will not speak any more (ended, or cut by a barge-in). */
  const doneKeys = new Set<string>()
  let generation = 0

  const remember = (set: Set<string>, key: string) => {
    set.add(key)
    if (set.size > 500) set.delete(set.values().next().value as string)
  }

  const sayChunk = (text: string, opts: SayOptions) => {
    const gen = generation
    void Promise.resolve(queue.say(text, opts))
      .catch(() => {})
      .then(() => {
        // A barge-in between the queueing and the hand-over already cut it.
        if (text && gen === generation) noteSpoken(text)
      })
  }

  const pump = (msgId: string, index: number, final: boolean): number => {
    const key = `${msgId}:${index}`
    const s = streams.get(key)
    if (!s) return 0
    const chunks = takeSpokenChunks(s.st, final)
    chunks.forEach((text, i) => {
      const fin = s.st.done && i === chunks.length - 1
      sayChunk(text, { stream: key, fin })
      s.sent += 1
      log(`[voice-speak] trozo #${s.sent} (${text.length} car.)${fin ? ' fin' : ''}`)
    })
    if (s.st.done) {
      remember(doneKeys, key)
      // The last chunk went out before the block knew it was the last one: close the stream.
      if (s.sent > 0 && chunks.length === 0) sayChunk('', { stream: key, fin: true })
      streams.delete(key)
    }
    return chunks.length
  }

  return {
    onDelta(msgId, index, text) {
      if (!enabled() || !msgId) return 0
      const key = `${msgId}:${index}`
      let s = streams.get(key)
      if (!s) {
        remember(streamed, msgId)
        if (doneKeys.has(key)) return 0 // block already finished or cut by a barge-in
        if (!allowed()) return 0 // nobody asked this session to speak (streams already started finish)
        s = { st: newSpokenStream(), sent: 0 }
        streams.set(key, s)
      }
      s.st.raw += text
      return pump(msgId, index, false)
    },
    onBlockEnd(msgId, index) {
      if (!enabled() || !msgId) return 0
      const n = pump(msgId, index, true)
      remember(doneKeys, `${msgId}:${index}`)
      return n
    },
    onEntry(entry) {
      if (!enabled()) return 0
      const turn = humanUserTurn(entry)
      if (turn) {
        // Every human message renews the permission: a typed one after a voice one revokes it.
        voicePermit = turn.origin === 'voice' && wantsSpokenReply(turn.text)
        log(`[voice-speak] turno ${turn.origin}${voicePermit ? ' con pregunta' : ''}`)
        return 0
      }
      const blocks = assistantTextBlocks(entry)
      if (blocks.length === 0) return 0
      const msgId = (entry.message as { id?: unknown } | undefined)?.id
      if (typeof msgId === 'string' && streamed.has(msgId)) return 0
      if (!allowed()) return 0
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : ''
      if (uuid) {
        if (seen.has(uuid)) return 0
        remember(seen, uuid)
      }
      let n = 0
      for (const b of blocks) {
        const text = pickSpokenText(b)
        if (!text) continue
        n += 1
        sayChunk(text, {})
        log(`[voice-speak] locución (${text.length} car.)`)
      }
      return n
    },
    bargeIn() {
      if (!enabled()) return
      generation += 1
      // The person talks over: the rest of the blocks being streamed is not spoken.
      for (const [key, s] of streams) {
        s.st.done = true
        remember(doneKeys, key)
      }
      streams.clear()
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
export type ProcessQueueOptions = {
  /** Alias of this session ("zorro rojo"), read on every say; default `getOwnSessionAlias()`. */
  getAlias?: () => string | undefined
  /** PID passed on every say (it goes to the utterance history so Orca knows which tab speaks); default `process.pid`. */
  pid?: number
  /** Session id, read on every say (survives --resume, unlike the random alias): the queue recognises the main session by it. */
  getSessionId?: () => string | undefined
}

/**
 * Who is speaking, as flags for enqueue_speech.py: `--session <id>` when known, always `--pid <pid>`, plus
 * `--alias <alias>` (no emoji) when the session has one.
 */
export function speakerFlags(opts: ProcessQueueOptions = {}): string[] {
  let alias: string | undefined
  try {
    alias = (opts.getAlias ?? (() => getOwnSessionAlias()?.alias))()
  } catch {}
  let session: string | undefined
  try {
    session = (opts.getSessionId ?? (() => String(getSessionId() ?? '')))()
  } catch {}
  const pid = [...(session ? ['--session', session] : []), '--pid', String(opts.pid ?? process.pid)]
  return alias ? [...pid, '--alias', alias] : pid
}

export function createProcessQueue(spawnFn: SpawnFn = nodeSpawn, qopts: ProcessQueueOptions = {}): SpeechQueue {
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
    say(text, opts = {}) {
      const extra = opts.stream ? ['--stream', opts.stream, ...(opts.fin ? ['--fin'] : [])] : []
      const job = chain.then(async () => {
        await ensureAlive()
        await run(spawnFn, [...ENQUEUE_SPEECH_ARGV, ...speakerFlags(qopts), '--prioridad', 'respuesta', ...extra, '--', text])
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
  if (!voiceListenActive()) return
  try {
    speaker().onEntry(entry)
  } catch (e) {
    logForDebugging(`[voice-speak] error: ${(e as Error).name}`)
  }
}

/** Streaming hook (claude.ts, main thread only): one text delta. No-op without the flag. */
export function voiceSpeakDelta(msgId: string | undefined, index: number, text: string): void {
  if (!voiceListenActive() || !msgId) return
  try {
    speaker().onDelta(msgId, index, text)
  } catch (e) {
    logForDebugging(`[voice-speak] error: ${(e as Error).name}`)
  }
}

/** Streaming hook (claude.ts, main thread only): a text block ended. No-op without the flag. */
export function voiceSpeakBlockEnd(msgId: string | undefined, index: number): void {
  if (!voiceListenActive() || !msgId) return
  try {
    speaker().onBlockEnd(msgId, index)
  } catch (e) {
    logForDebugging(`[voice-speak] error: ${(e as Error).name}`)
  }
}

/** Hooks barge-in to the listener's `speech_start`. Returns the uninstall function. */
export function installVoiceSpeak(): () => void {
  setSpeechStartHandler(() => speaker().bargeIn())
  setStopHandler(() => speaker().bargeIn()) // /escucha off: silence whatever is still queued
  return () => {
    setSpeechStartHandler(undefined)
    setStopHandler(undefined)
  }
}
