/**
 * Pure core of the Matrix event channel (contract: docs/matrix_events.md, v2).
 *
 * Everything here is free of I/O and of module state: building and serializing
 * events, parsing the input lines of `FNHARNESS_INPUT`, splitting a byte stream
 * into lines, mapping an `ask_answer` onto the questions of an AskUserQuestion
 * dialog and the input-queue state machine. The effects (file append, FIFO
 * reading, hooks into the REPL) live in `matrixEventsRuntime.ts`.
 */

export const MATRIX_EVENTS_VERSION = 2

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

/** Capabilities announced in `session_start.caps` (v2). */
export type MatrixCap = 'entries' | 'mcp'

/** One transcript entry as it is serialized into the session JSONL. */
export type TranscriptEntryObject = Record<string, unknown>

/** The type-specific part of each event; the common fields are added by `buildEvent`. */
export type EventBody =
  | {
      type: 'session_start'
      cwd: string
      account: string
      model: string
      resumed: boolean
      pid: number
      caps: MatrixCap[]
    }
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
  | { type: 'entry'; entry: TranscriptEntryObject; input_id?: string; truncated?: true }
  | { type: 'mcp_settled'; connected: number; failed: number; pending: number }
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

// ── entry trimming (v2) ──────────────────────────────────────────────────

/** A `tool_result` text longer than this is cut. */
export const MAX_TOOL_RESULT_CHARS = 8 * 1024
/** The serialized event line never goes past this (the reader drops lines over 1 MB). */
export const MAX_ENTRY_LINE_BYTES = 900 * 1024

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8')

function cutText(text: string, max: number): string {
  const omitted = text.length - max
  return `${text.slice(0, max)}\n[… recortado: ${omitted} caracteres más]`
}

/** Shrinks the content of a `tool_result` block (string or list of blocks). Returns null if nothing changed. */
function trimToolResultContent(content: unknown, max: number): unknown | null {
  if (typeof content === 'string') return content.length > max ? cutText(content, max) : null
  if (!Array.isArray(content)) return null
  let changed = false
  const out = content.map(part => {
    if (!isObj(part)) return part
    // Inside a tool_result every text part obeys the tool_result limit.
    const replaced =
      part.type === 'text' && typeof part.text === 'string' && part.text.length > max
        ? { ...part, text: cutText(part.text, max) }
        : trimBlock(part, max)
    if (replaced !== part) changed = true
    return replaced
  })
  return changed ? out : null
}

/** Trims one content block: cuts long tool_result text and replaces base64 images. Never mutates. */
function trimBlock(block: Record<string, unknown>, max: number): Record<string, unknown> {
  if (block.type === 'image') {
    const source = block.source
    if (isObj(source) && source.type === 'base64') {
      const data = typeof source.data === 'string' ? source.data : ''
      const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image'
      return { type: 'text', text: `[imagen omitida: ${mediaType}, ${data.length} caracteres base64]` }
    }
    return block
  }
  if (block.type === 'tool_result') {
    const content = trimToolResultContent(block.content, max)
    return content === null ? block : { ...block, content }
  }
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > max * 64) {
    // A single text block of more than 512 KB cannot be a human message; keep the line under the limit.
    return { ...block, text: cutText(block.text, max * 64) }
  }
  return block
}

function trimMessageContent(entry: TranscriptEntryObject, max: number): TranscriptEntryObject {
  const message = entry.message
  if (!isObj(message) || !Array.isArray(message.content)) return entry
  let changed = false
  const content = message.content.map(part => {
    if (!isObj(part)) return part
    const replaced = trimBlock(part, max)
    if (replaced !== part) changed = true
    return replaced
  })
  return changed ? { ...entry, message: { ...message, content } } : entry
}

/**
 * Prepares a transcript entry for the `entry` event (contract v2): `tool_result`
 * text above 8 KB is cut with a marker, base64 images become a text marker, and
 * if the serialized entry is still over ~900 KB the cut tightens until it fits
 * (the last resort replaces the whole message content). Pure: the input is not
 * mutated; when nothing needs trimming the same object comes back with
 * `truncated: false`.
 */
export function trimEntryForEvent(entry: TranscriptEntryObject): {
  entry: TranscriptEntryObject
  truncated: boolean
} {
  let current = trimMessageContent(entry, MAX_TOOL_RESULT_CHARS)
  const tooBig = (e: TranscriptEntryObject) => {
    try {
      return byteLength(JSON.stringify(e)) > MAX_ENTRY_LINE_BYTES
    } catch {
      return true
    }
  }
  // Tool results far above the limit may still add up (many blocks): tighten stepwise.
  for (let max = MAX_TOOL_RESULT_CHARS / 2; tooBig(current) && max >= 256; max = Math.floor(max / 2)) {
    current = trimMessageContent(current, max)
  }
  if (tooBig(current)) {
    // Something outside the content is huge (toolUseResult, a giant text): keep only the identity of the entry.
    const message = isObj(current.message) ? current.message : undefined
    const { toolUseResult: _drop, ...rest } = current
    current = {
      ...rest,
      ...(message
        ? { message: { ...message, content: [{ type: 'text', text: '[contenido omitido: entrada demasiado grande]' }] } }
        : {}),
    }
  }
  return { entry: current, truncated: current !== entry }
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

// ── MCP initial connection tally ─────────────────────────────────────────

export type McpTally = { connected: number; failed: number; pending: number }

/**
 * Counts the initial MCP connections: `states` maps each server name to the
 * type of its last connection attempt (`connected`, `failed`, `needs-auth`...),
 * `expected` is how many servers were to be connected. A server with no
 * attempt yet is `pending`; `failed` includes `needs-auth`; anything else a
 * settled attempt can end in (`disabled`) counts as neither.
 */
export function tallyMcp(states: ReadonlyMap<string, string>, expected: number): McpTally {
  let connected = 0
  let failed = 0
  let other = 0
  for (const type of states.values()) {
    if (type === 'connected') connected++
    else if (type === 'failed' || type === 'needs-auth') failed++
    else other++
  }
  return { connected, failed, pending: Math.max(0, expected - connected - failed - other) }
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
  /** The initial MCP connections have not settled: no `ready` and no queued prompt goes out yet. */
  mcpWait: boolean
  pending: QueuedPrompt[]
}

export type FlowEvent =
  | { kind: 'idle'; idle: boolean }
  | { kind: 'turn_start'; source: TurnSource }
  | { kind: 'turn_end'; reason: TurnEndReason }
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'interrupt' }
  | { kind: 'submit_timeout' }
  | { kind: 'mcp_wait'; wait: boolean }

export type FlowAction =
  | { kind: 'emit'; body: EventBody }
  | { kind: 'submit'; id: string; text: string; source: TurnSource }
  | { kind: 'interrupt' }

export const initialFlow: FlowState = {
  idle: false,
  openTurns: 0,
  readySent: false,
  submitting: false,
  mcpWait: false,
  pending: [],
}

const quiet = (s: FlowState) => s.idle && s.openTurns === 0 && !s.submitting && !s.mcpWait

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
    case 'mcp_wait':
      return settle({ ...s, mcpWait: e.wait })
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
