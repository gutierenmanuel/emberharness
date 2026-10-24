/**
 * Pure core of the Matrix event channel (contract: docs/matrix_events.md, v1).
 *
 * Everything here is free of I/O and of module state: building and serializing
 * events, parsing the input lines of `FNHARNESS_INPUT`, splitting a byte stream
 * into lines, mapping an `ask_answer` onto the questions of an AskUserQuestion
 * dialog and the input-queue state machine. The effects (file append, FIFO
 * reading, hooks into the REPL) live in `matrixEventsRuntime.ts`.
 */

export const MATRIX_EVENTS_VERSION = 1

// ── events (output) ──────────────────────────────────────────────────────

export type TurnSource = 'user' | 'queued' | 'scheduled'
export type TurnEndReason = 'completed' | 'interrupted' | 'error'
export type SessionSwitchReason = 'clear' | 'resume' | 'compact'

export type AskOption = { label: string; description: string }
export type AskQuestion = {
  header: string
  question: string
  multiSelect: boolean
  options: AskOption[]
}

/** The type-specific part of each event; the common fields are added by `buildEvent`. */
export type EventBody =
  | { type: 'session_start'; cwd: string; account: string; model: string; resumed: boolean; pid: number }
  | { type: 'ready' }
  | { type: 'turn_start'; source: TurnSource }
  | { type: 'turn_end'; reason: TurnEndReason }
  | { type: 'ask_user'; tool_use_id: string; questions: AskQuestion[] }
  | { type: 'ask_user_done'; tool_use_id: string; answered: boolean }
  | { type: 'permission_prompt'; tool_use_id: string; tool: string; summary: string }
  | { type: 'input_queued'; id: string; text_len: number }
  | { type: 'input_accepted'; id: string; text_len: number }
  | {
      type: 'session_switch'
      old_session_id: string
      new_session_id: string
      reason: SessionSwitchReason
    }
  | { type: 'exit'; code: number }

export type EventType = EventBody['type']

export type MatrixEvent = EventBody & {
  v: number
  seq: number
  ts: string
  session_id: string
}

/** Builds a complete event. Pure: the caller supplies sequence number, clock and session. */
export function buildEvent(
  meta: { seq: number; now: Date; sessionId: string },
  body: EventBody,
): MatrixEvent {
  return {
    v: MATRIX_EVENTS_VERSION,
    seq: meta.seq,
    ts: meta.now.toISOString(),
    session_id: meta.sessionId,
    ...body,
  }
}

/** One JSONL line, newline included, ready for a single `write`. */
export function serializeEvent(event: MatrixEvent): string {
  return JSON.stringify(event) + '\n'
}

/** Cuts `text` to at most `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + '…'
}

/** Shapes the questions of an AskUserQuestion call as the contract's `ask_user` payload. */
export function toAskQuestions(
  questions: ReadonlyArray<{
    header?: string
    question: string
    multiSelect?: boolean
    options: ReadonlyArray<{ label: string; description?: string }>
  }>,
): AskQuestion[] {
  return questions.map(q => ({
    header: q.header ?? '',
    question: q.question,
    multiSelect: q.multiSelect === true,
    options: q.options.map(o => ({ label: o.label, description: o.description ?? '' })),
  }))
}

// ── input (FNHARNESS_INPUT) ──────────────────────────────────────────────

export type InputMessage =
  | { type: 'prompt'; id: string; text: string }
  | {
      type: 'ask_answer'
      tool_use_id: string
      selected: string[]
      text?: string
      /** Optional extension: answer per question text, for dialogs with several questions. */
      answers?: Record<string, string>
    }
  | { type: 'interrupt' }

export type ParseResult = { ok: true; msg: InputMessage } | { ok: false; reason: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parses one line of the input channel. Never throws. */
export function parseInputLine(line: string): ParseResult {
  const trimmed = line.trim()
  if (trimmed === '') return { ok: false, reason: 'empty line' }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  if (!isRecord(raw)) return { ok: false, reason: 'not a JSON object' }
  switch (raw.type) {
    case 'prompt': {
      const id = raw.id
      if (typeof id !== 'string' && typeof id !== 'number') return { ok: false, reason: 'prompt without id' }
      if (typeof raw.text !== 'string' || raw.text === '') return { ok: false, reason: 'prompt without text' }
      return { ok: true, msg: { type: 'prompt', id: String(id), text: raw.text } }
    }
    case 'ask_answer': {
      if (typeof raw.tool_use_id !== 'string' || raw.tool_use_id === '') {
        return { ok: false, reason: 'ask_answer without tool_use_id' }
      }
      const selected = raw.selected
      if (selected !== undefined && (!Array.isArray(selected) || !selected.every(s => typeof s === 'string'))) {
        return { ok: false, reason: 'ask_answer.selected must be a list of labels' }
      }
      if (raw.text !== undefined && typeof raw.text !== 'string') {
        return { ok: false, reason: 'ask_answer.text must be a string' }
      }
      let answers: Record<string, string> | undefined
      if (raw.answers !== undefined) {
        if (!isRecord(raw.answers) || !Object.values(raw.answers).every(v => typeof v === 'string')) {
          return { ok: false, reason: 'ask_answer.answers must map question to string' }
        }
        answers = raw.answers as Record<string, string>
      }
      const hasSelected = Array.isArray(selected) && selected.length > 0
      if (!hasSelected && !raw.text && !answers) {
        return { ok: false, reason: 'ask_answer without selected, text or answers' }
      }
      return {
        ok: true,
        msg: {
          type: 'ask_answer',
          tool_use_id: raw.tool_use_id,
          selected: (selected as string[] | undefined) ?? [],
          ...(typeof raw.text === 'string' && raw.text !== '' ? { text: raw.text } : {}),
          ...(answers ? { answers } : {}),
        },
      }
    }
    case 'interrupt':
      return { ok: true, msg: { type: 'interrupt' } }
    default:
      return { ok: false, reason: `unknown type ${JSON.stringify(raw.type)}` }
  }
}

export const MAX_LINE_BYTES = 1024 * 1024

/**
 * Splits a byte stream into complete lines. `carry` is the unfinished tail of
 * the previous chunk; it is kept as bytes so a multi-byte character cut by a
 * read boundary is never decoded half. A tail longer than MAX_LINE_BYTES is
 * dropped (`overflow: true`) so a writer that never sends a newline cannot grow
 * memory without bound.
 */
export function drainLines(
  carry: Uint8Array,
  chunk: Uint8Array,
): { lines: string[]; carry: Uint8Array; overflow: boolean } {
  const buf = new Uint8Array(carry.length + chunk.length)
  buf.set(carry, 0)
  buf.set(chunk, carry.length)
  const lines: string[] = []
  const decoder = new TextDecoder()
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(decoder.decode(buf.subarray(start, i)))
      start = i + 1
    }
  }
  const rest = buf.subarray(start)
  if (rest.length > MAX_LINE_BYTES) return { lines, carry: new Uint8Array(0), overflow: true }
  return { lines, carry: rest.slice(), overflow: false }
}

// ── ask_answer → answers of the AskUserQuestion dialog ────────────────────

/**
 * Maps an `ask_answer` onto the dialog's `answers` (question text → answer).
 * - `answers` (extension) is used as is, restricted to the dialog's questions.
 * - One question: `selected` labels (joined by ", " for multi-select) plus the
 *   free `text` when the question is multi-select; for single-select `text`
 *   (the "Other" answer) wins over `selected`.
 * - Several questions: `selected[i]` answers question i.
 * Returns null when nothing usable was given.
 */
export function buildAskAnswers(
  questions: ReadonlyArray<{ question: string; multiSelect?: boolean }>,
  msg: Extract<InputMessage, { type: 'ask_answer' }>,
): Record<string, string> | null {
  const out: Record<string, string> = {}
  if (msg.answers) {
    for (const q of questions) {
      const a = msg.answers[q.question]
      if (a !== undefined && a !== '') out[q.question] = a
    }
    return Object.keys(out).length === questions.length ? out : null
  }
  if (questions.length === 1) {
    const q = questions[0]!
    if (q.multiSelect) {
      const parts = [...msg.selected, ...(msg.text ? [msg.text] : [])]
      if (parts.length === 0) return null
      out[q.question] = parts.join(', ')
    } else {
      const a = msg.text ?? msg.selected[0]
      if (a === undefined || a === '') return null
      out[q.question] = a
    }
    return out
  }
  if (msg.selected.length < questions.length) return null
  questions.forEach((q, i) => {
    out[q.question] = msg.selected[i]!
  })
  return out
}

// ── input queue state machine ────────────────────────────────────────────

export type QueuedPrompt = { id: string; text: string }

export type FlowState = {
  /** The REPL reports the prompt can take input (no turn, dialog or pending command). */
  idle: boolean
  /** Turns that emitted `turn_start` and have not emitted `turn_end` (a superseded turn can overlap). */
  openTurns: number
  /** A `ready` was already sent for the current quiet period. */
  readySent: boolean
  /** A prompt was handed to the REPL and has not been picked up yet. */
  submitting: boolean
  pending: QueuedPrompt[]
}

export type FlowEvent =
  | { kind: 'idle'; idle: boolean }
  | { kind: 'turn_start'; source: TurnSource }
  | { kind: 'turn_end'; reason: TurnEndReason }
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'interrupt' }
  | { kind: 'submit_timeout' }

export type FlowAction =
  | { kind: 'emit'; body: EventBody }
  | { kind: 'submit'; id: string; text: string; source: TurnSource }
  | { kind: 'interrupt' }

export const initialFlow: FlowState = {
  idle: false,
  openTurns: 0,
  readySent: false,
  submitting: false,
  pending: [],
}

const quiet = (s: FlowState) => s.idle && s.openTurns === 0 && !s.submitting

/** When the prompt is free: send the next queued prompt, or announce `ready` once. */
function settle(s: FlowState): { state: FlowState; actions: FlowAction[] } {
  if (!quiet(s)) return { state: s, actions: [] }
  const next = s.pending[0]
  if (next) {
    return {
      state: { ...s, pending: s.pending.slice(1), submitting: true, readySent: false },
      actions: [
        { kind: 'emit', body: { type: 'input_accepted', id: next.id, text_len: next.text.length } },
        { kind: 'submit', id: next.id, text: next.text, source: 'queued' },
      ],
    }
  }
  if (s.readySent) return { state: s, actions: [] }
  return { state: { ...s, readySent: true }, actions: [{ kind: 'emit', body: { type: 'ready' } }] }
}

export function stepFlow(s: FlowState, e: FlowEvent): { state: FlowState; actions: FlowAction[] } {
  switch (e.kind) {
    case 'idle': {
      // A prompt handed to the REPL is "picked up" once the REPL stops being idle.
      const state = { ...s, idle: e.idle, submitting: e.idle ? s.submitting : false }
      return settle(state)
    }
    case 'submit_timeout':
      return settle({ ...s, submitting: false })
    case 'turn_start':
      return {
        state: { ...s, openTurns: s.openTurns + 1, submitting: false, readySent: false },
        actions: [{ kind: 'emit', body: { type: 'turn_start', source: e.source } }],
      }
    case 'turn_end': {
      const state = { ...s, openTurns: Math.max(0, s.openTurns - 1) }
      const settled = settle(state)
      return {
        state: settled.state,
        actions: [{ kind: 'emit', body: { type: 'turn_end', reason: e.reason } }, ...settled.actions],
      }
    }
    case 'prompt': {
      if (quiet(s) && s.pending.length === 0) {
        return {
          state: { ...s, submitting: true, readySent: false },
          actions: [
            { kind: 'emit', body: { type: 'input_accepted', id: e.id, text_len: e.text.length } },
            { kind: 'submit', id: e.id, text: e.text, source: 'user' },
          ],
        }
      }
      return {
        state: { ...s, pending: [...s.pending, { id: e.id, text: e.text }] },
        actions: [{ kind: 'emit', body: { type: 'input_queued', id: e.id, text_len: e.text.length } }],
      }
    }
    case 'interrupt':
      return { state: s, actions: s.openTurns > 0 || !s.idle ? [{ kind: 'interrupt' }] : [] }
  }
}
