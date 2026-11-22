/**
 * Live voice state for the input area: what the person is saying RIGHT NOW,
 * chunk by chunk, before the phrase closes.
 *
 * The voice child prints a `fragment` event for every chunk of the person's
 * speech the moment it sees it, and an `utterance` when the phrase closes. The
 * utterance is queued as one voice message (see voiceListenRuntime.ts). This
 * module keeps the in-between state so the screen can show it:
 *
 *   listening  -> ready, nothing said
 *   dictating  -> fragments are arriving; `text` is what was said so far
 *   sent       -> the phrase closed and was enqueued (briefly, for feedback)
 *
 * "queued" (waiting for the running tool to finish) is not stored here: it is
 * derived from the command queue by the component, because the queue is the
 * source of truth for whether the model has taken the message yet.
 *
 * The live text is NEVER written into the prompt buffer: the person may be
 * typing, and overwriting their text is worse than a separate line above the
 * input. The utterance replaces the live text, so nothing is shown twice and
 * the message sent is the whole phrase, exactly once.
 *
 * Pure and clock-injectable; the only side effect is the change signal.
 */

import { createSignal } from './signal.js'

/** A dictation with no new chunk for this long is dropped (the phrase never closed: gate discard, child died). */
export const LIVE_TTL_MS = 12_000
/** How long the "sent" confirmation stays on screen. */
export const SENT_TTL_MS = 2_500
/** Cap on the live text kept: the line shows the tail anyway. */
export const MAX_LIVE_CHARS = 2_000

export type VoiceLivePhase = 'off' | 'listening' | 'dictating' | 'sent'

export type VoiceLive = {
  phase: VoiceLivePhase
  /** Fragments joined so far; empty unless dictating. */
  text: string
  mic: string | null
  fragments: number
  /** Epoch ms of the last fragment (for the TTL). */
  fragmentAt: number | null
  /** Epoch ms when the first fragment of the current phrase arrived. */
  startedAt: number | null
  /** Epoch ms when the last phrase was handed to the queue; chars of it (never the text). */
  sentAt: number | null
  sentChars: number
}

const OFF: VoiceLive = {
  phase: 'off',
  text: '',
  mic: null,
  fragments: 0,
  fragmentAt: null,
  startedAt: null,
  sentAt: null,
  sentChars: 0,
}

let state: VoiceLive = OFF
const seenBlocks = new Set<string>()
const changed = createSignal()

export const subscribeVoiceLive = changed.subscribe
/** Snapshot for useSyncExternalStore: the reference changes only on mutation. */
export const getVoiceLive = (): VoiceLive => state

function set(next: VoiceLive): void {
  state = next
  changed.emit()
}

/** Joins a new chunk to the text so far, skipping an exact repeat of the previous chunk. */
export function appendFragment(text: string, chunk: string): string {
  const c = chunk.trim()
  if (!c) return text
  if (!text) return c.slice(0, MAX_LIVE_CHARS)
  if (text === c || text.endsWith(' ' + c)) return text // the same chunk twice in a row
  return `${text} ${c}`.slice(-MAX_LIVE_CHARS)
}

export function voiceLiveReady(): void {
  if (state.phase === 'off') set({ ...OFF, phase: 'listening' })
}

/** The child died or listening stopped: nothing is live any more. */
export function voiceLiveReset(): void {
  seenBlocks.clear()
  if (state !== OFF) set(OFF)
}

export function voiceLiveFragment(e: { text: string; mic: string; blockId?: string | number | null }, now: number = Date.now()): void {
  if (state.phase === 'off') return
  if (e.blockId !== undefined && e.blockId !== null) {
    const k = `${e.mic}:${e.blockId}`
    if (seenBlocks.has(k)) return // the same chunk delivered twice
    seenBlocks.add(k)
    if (seenBlocks.size > 200) seenBlocks.delete(seenBlocks.values().next().value as string)
  }
  const dictating = state.phase === 'dictating'
  const text = appendFragment(dictating ? state.text : '', e.text)
  if (!text || (dictating && text === state.text)) return // nothing new to show
  set({
    ...state,
    phase: 'dictating',
    text,
    mic: e.mic,
    fragments: (dictating ? state.fragments : 0) + 1,
    fragmentAt: now,
    startedAt: dictating ? state.startedAt : now,
  })
}

/** The phrase closed and was enqueued: the live text gives way to the queued message. */
export function voiceLiveSent(chars: number, now: number = Date.now()): void {
  if (state.phase === 'off') return
  set({ ...state, phase: 'sent', text: '', fragments: 0, fragmentAt: null, startedAt: null, sentAt: now, sentChars: chars })
}

/** The phrase went elsewhere (routed to another session) or the gate discarded it: drop the live text. */
export function voiceLiveDiscard(): void {
  if (state.phase === 'off') return
  set({ ...state, phase: 'listening', text: '', fragments: 0, fragmentAt: null, startedAt: null })
}

/** Time-based decay; returns true when the state changed. Called by the component's timer. */
export function voiceLiveExpire(now: number = Date.now()): boolean {
  if (state.phase === 'dictating' && state.fragmentAt !== null && now - state.fragmentAt >= LIVE_TTL_MS) {
    voiceLiveDiscard()
    return true
  }
  if (state.phase === 'sent' && state.sentAt !== null && now - state.sentAt >= SENT_TTL_MS) {
    set({ ...state, phase: 'listening' })
    return true
  }
  return false
}

/** Ms until the next decay is due, or null when nothing decays. */
export function voiceLiveNextExpiry(now: number = Date.now()): number | null {
  if (state.phase === 'dictating' && state.fragmentAt !== null) return Math.max(0, state.fragmentAt + LIVE_TTL_MS - now)
  if (state.phase === 'sent' && state.sentAt !== null) return Math.max(0, state.sentAt + SENT_TTL_MS - now)
  return null
}

export type VoiceLineKind = 'off' | 'listening' | 'dictating' | 'sent' | 'queued'

export type VoiceLineView = { kind: VoiceLineKind; text: string; waiting: number }

/**
 * What the line above the input shows. Priority: dictating (what is being said
 * now) > queued (a voice message the model has not taken yet) > sent > listening.
 */
export function voiceLineView(s: VoiceLive, queuedVoice: number): VoiceLineView {
  if (s.phase === 'off') return { kind: 'off', text: '', waiting: 0 }
  if (s.phase === 'dictating') return { kind: 'dictating', text: s.text, waiting: queuedVoice }
  if (queuedVoice > 0) return { kind: 'queued', text: '', waiting: queuedVoice }
  if (s.phase === 'sent') return { kind: 'sent', text: '', waiting: 0 }
  return { kind: 'listening', text: '', waiting: 0 }
}
