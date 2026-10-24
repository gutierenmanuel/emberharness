// Pure logic behind `/goal`: argument parsing, the stop/continue decision after
// each turn, the judge prompt and verdict parsing, and the status/indicator
// text. No I/O and no bootstrap state, so everything here is unit-testable.

export const GOAL_DEFAULT_MAX_TURNS = 30
export const GOAL_MAX_TURNS_CEILING = 500
/** Consecutive turns without a single tool call before the goal is dropped. */
export const GOAL_MAX_IDLE_TURNS = 3
/** Characters of transcript handed to the judge (small local models: 32k context). */
export const GOAL_TRANSCRIPT_BUDGET = 12_000
const TOOL_RESULT_CHARS = 700
const TOOL_INPUT_CHARS = 300
const ASSISTANT_TEXT_CHARS = 2_500

export type GoalArgs =
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'set'; condition: string; judge: string | null; maxTurns: number | null }
  | { kind: 'error'; message: string }

export const GOAL_USAGE = `Uso: /goal <condición> [--judge <cuenta>] [--turns N]

Mantiene al agente trabajando turno tras turno hasta que un evaluador confirma que la condición se cumple (o es imposible).

  /goal todos los tests de src/utils pasan     fija el objetivo y empieza a trabajar
  /goal                                         muestra el estado
  /goal clear                                   quita el objetivo
  --judge <cuenta>   cuenta del evaluador (p. ej. claude); por defecto la cuenta activa
  --turns N          tope de turnos (por defecto ${GOAL_DEFAULT_MAX_TURNS})`

const CLEAR_WORDS = new Set(['clear', 'off', 'stop', 'cancel', 'none', 'reset', 'remove'])

/** Parse the raw `/goal` arguments. Flags may appear anywhere in the text. */
export function parseGoalArgs(raw: string): GoalArgs {
  const input = raw.trim()
  if (input === '') return { kind: 'status' }
  if (CLEAR_WORDS.has(input.toLowerCase())) return { kind: 'clear' }

  const tokens = input.split(/\s+/)
  const rest: string[] = []
  let judge: string | null = null
  let maxTurns: number | null = null
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const eq = /^--(judge|turns)=(.*)$/.exec(tok)
    const flag = eq ? eq[1]! : tok === '--judge' || tok === '--turns' ? tok.slice(2) : null
    if (flag === null) {
      rest.push(tok)
      continue
    }
    const value = eq ? eq[2]! : tokens[++i]
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { kind: 'error', message: `Falta el valor de --${flag}.\n\n${GOAL_USAGE}` }
    }
    if (flag === 'judge') {
      judge = value
    } else {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > GOAL_MAX_TURNS_CEILING) {
        return {
          kind: 'error',
          message: `--turns debe ser un entero entre 1 y ${GOAL_MAX_TURNS_CEILING} (recibido "${value}").`,
        }
      }
      maxTurns = n
    }
  }
  const condition = rest.join(' ').trim()
  if (condition === '') {
    return { kind: 'error', message: `Falta la condición del objetivo.\n\n${GOAL_USAGE}` }
  }
  return { kind: 'set', condition, judge, maxTurns }
}

// --- state machine -----------------------------------------------------------

export type GoalState = {
  condition: string
  /** Account id of the evaluator; null = the active account. */
  judge: string | null
  maxTurns: number
  startedAt: number
  /** Turns evaluated so far. */
  turns: number
  /** Input + output tokens (agent and judge) consumed since the goal was set. */
  tokens: number
  /** Session-wide token counter at the last checkpoint; deltas feed `tokens`. */
  tokenMark: number
  /** Consecutive evaluated turns that made no tool call. */
  idleStreak: number
  /** Uuid of the last message already accounted for. */
  lastUuid: string | null
  /** Last reason the evaluator gave for "not met". */
  lastReason: string | null
}

export function newGoalState(
  condition: string,
  opts: { judge?: string | null; maxTurns?: number | null; now?: number; tokenMark?: number } = {},
): GoalState {
  return {
    condition,
    judge: opts.judge ?? null,
    maxTurns: opts.maxTurns ?? GOAL_DEFAULT_MAX_TURNS,
    startedAt: opts.now ?? Date.now(),
    turns: 0,
    tokens: 0,
    tokenMark: opts.tokenMark ?? 0,
    idleStreak: 0,
    lastUuid: null,
    lastReason: null,
  }
}

export type GoalVerdict = { status: 'met' | 'not_met' | 'impossible'; reason: string }

export type GoalDecision =
  | { action: 'continue'; state: GoalState }
  | { action: 'achieved' | 'impossible' | 'idle' | 'max_turns'; state: GoalState }

/**
 * What to do after the agent finished a turn and the judge answered.
 * `usedTools`: whether the turn made at least one tool call; `totalTokens`: the
 * session-wide token counter now. The returned state already counts this turn.
 */
export function decideAfterTurn(
  state: GoalState,
  verdict: GoalVerdict,
  turn: { usedTools: boolean; totalTokens: number; lastUuid: string | null },
): GoalDecision {
  const next: GoalState = {
    ...state,
    turns: state.turns + 1,
    tokens: state.tokens + Math.max(0, turn.totalTokens - state.tokenMark),
    tokenMark: turn.totalTokens,
    idleStreak: turn.usedTools ? 0 : state.idleStreak + 1,
    lastUuid: turn.lastUuid ?? state.lastUuid,
    lastReason: verdict.reason || state.lastReason,
  }
  if (verdict.status === 'met') return { action: 'achieved', state: next }
  if (verdict.status === 'impossible') return { action: 'impossible', state: next }
  if (next.idleStreak >= GOAL_MAX_IDLE_TURNS) return { action: 'idle', state: next }
  if (next.turns >= next.maxTurns) return { action: 'max_turns', state: next }
  return { action: 'continue', state: next }
}

// --- text --------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** One-line indicator shown after every evaluated turn. */
export function formatIndicator(state: GoalState, now: number): string {
  return `◎ /goal · turno ${state.turns}/${state.maxTurns} · ${formatDuration(now - state.startedAt)} · ${formatTokens(state.tokens)} tokens · ${truncate(state.condition, 60)}`
}

/** Multi-line answer of a bare `/goal`. */
export function formatStatus(state: GoalState | null, now: number): string {
  if (!state) return 'Sin objetivo activo. Usa /goal <condición> para fijar uno.'
  const lines = [
    `Objetivo activo: ${state.condition}`,
    `Turnos: ${state.turns}/${state.maxTurns} · Tiempo: ${formatDuration(now - state.startedAt)} · Tokens: ${formatTokens(state.tokens)}`,
    `Evaluador: ${state.judge ?? 'cuenta activa'}`,
  ]
  if (state.lastReason) lines.push(`Último veredicto: ${truncate(state.lastReason, 300)}`)
  return lines.join('\n')
}

/** Final message once the loop ends for a reason other than `continue`. */
export function formatOutcome(
  action: 'achieved' | 'impossible' | 'idle' | 'max_turns' | 'judge_error' | 'cleared',
  state: GoalState,
  now: number,
  detail?: string,
): string {
  const stats = `${state.turns} turnos · ${formatDuration(now - state.startedAt)} · ${formatTokens(state.tokens)} tokens`
  switch (action) {
    case 'achieved':
      return `◎ /goal cumplido (${stats}): ${truncate(state.lastReason ?? state.condition, 300)}`
    case 'impossible':
      return `◎ /goal abandonado, el evaluador lo considera imposible (${stats}): ${truncate(state.lastReason ?? '', 300)}`
    case 'idle':
      return `◎ /goal detenido: ${GOAL_MAX_IDLE_TURNS} turnos seguidos sin usar herramientas (${stats}). Último veredicto: ${truncate(state.lastReason ?? 'sin motivo', 300)}`
    case 'max_turns':
      return `◎ /goal detenido: tope de ${state.maxTurns} turnos alcanzado (${stats}). Último veredicto: ${truncate(state.lastReason ?? 'sin motivo', 300)}`
    case 'judge_error':
      return `◎ /goal detenido: el evaluador falló (${truncate(detail ?? 'error desconocido', 300)}). ${stats}`
    case 'cleared':
      return `◎ /goal quitado (${stats}).`
  }
}

/** Meta message that starts work right after `/goal <condition>`. */
export function buildKickoffPrompt(condition: string): string {
  return `A goal is now active for this session: ${condition}

Work toward it now. After every turn an independent evaluator checks whether the condition holds, and you will keep being asked to continue until it does. Use tools to make real progress and to verify the result, and state clearly in your final message what you did and what the evidence is.`
}

/** Meta message that keeps the agent going when the judge said "not met". */
export function buildContinuePrompt(condition: string, reason: string): string {
  return `Goal not met yet: ${condition}
Evaluator feedback: ${reason || 'no reason given'}

Keep working toward the goal. Do the next concrete step with tools, verify it, and say what evidence now shows the condition holds.`
}

// --- judge -------------------------------------------------------------------

export const JUDGE_SYSTEM_PROMPT = `You are a strict, impartial evaluator of an AI coding agent's progress. You are given a goal condition and the recent transcript of the agent working on it. Decide from the evidence in the transcript only (tool outputs, test results, files shown), never from the agent's own claims alone.

Reply with ONE JSON object and nothing else:
{"status": "met" | "not_met" | "impossible", "reason": "<one or two sentences>"}

- "met": the transcript shows evidence that the condition is satisfied now.
- "not_met": the condition is not yet satisfied, or there is no evidence; say what is missing.
- "impossible": the condition cannot be achieved (blocked, contradictory, or needs something the agent cannot do).`

export type TranscriptEntry = { role: 'user' | 'assistant' | 'tool'; text: string }

type LooseBlock = {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
}
export type LooseMessage = {
  type?: string
  isMeta?: boolean
  message?: { content?: unknown }
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as LooseBlock[])
    .map(b => (b.type === 'text' || b.text !== undefined ? (b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** Flatten model messages into short transcript entries (pure, structural). */
export function messagesToEntries(messages: LooseMessage[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const m of messages) {
    const content = m.message?.content
    if (m.type === 'assistant') {
      const blocks = Array.isArray(content) ? (content as LooseBlock[]) : []
      const text = truncate(blockText(content), ASSISTANT_TEXT_CHARS)
      if (text) out.push({ role: 'assistant', text })
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          out.push({
            role: 'assistant',
            text: `[tool ${b.name ?? '?'} ${truncate(safeJson(b.input), TOOL_INPUT_CHARS)}]`,
          })
        }
      }
    } else if (m.type === 'user') {
      const blocks = Array.isArray(content) ? (content as LooseBlock[]) : []
      let hadResult = false
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          hadResult = true
          out.push({ role: 'tool', text: truncate(blockText(b.content), TOOL_RESULT_CHARS) })
        }
      }
      if (!hadResult && !m.isMeta) {
        const text = truncate(blockText(content), ASSISTANT_TEXT_CHARS)
        if (text) out.push({ role: 'user', text })
      }
    }
  }
  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

/** Keep the newest entries that fit in `budget` characters. */
export function renderTranscript(entries: TranscriptEntry[], budget = GOAL_TRANSCRIPT_BUDGET): string {
  const lines: string[] = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    const line = `${e.role.toUpperCase()}: ${e.text}`
    if (used + line.length > budget && lines.length > 0) {
      lines.push('(earlier transcript omitted)')
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.reverse().join('\n')
}

export function buildJudgePrompt(condition: string, transcript: string): string {
  return `GOAL CONDITION:
${condition}

RECENT TRANSCRIPT:
${transcript || '(empty)'}

Does the transcript show the goal condition is met now? Answer with the JSON object only.`
}

/**
 * Tolerant verdict parser: accepts bare JSON, fenced JSON, JSON embedded in
 * prose, and the legacy `{"ok": bool}` shape. Anything unparseable is "not met"
 * with the raw text as reason, so a confused judge never ends the goal early.
 */
export function parseVerdict(text: string): GoalVerdict {
  const raw = text.trim()
  const candidates: string[] = [raw]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fenced) candidates.push(fenced[1]!.trim())
  const braces = /\{[\s\S]*\}/.exec(raw)
  if (braces) candidates.push(braces[0])
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as { status?: unknown; ok?: unknown; reason?: unknown }
      const reason = typeof j.reason === 'string' ? j.reason : ''
      if (j.status === 'met' || j.status === 'not_met' || j.status === 'impossible') {
        return { status: j.status, reason }
      }
      if (typeof j.ok === 'boolean') return { status: j.ok ? 'met' : 'not_met', reason }
    } catch {
      // try the next candidate
    }
  }
  return { status: 'not_met', reason: truncate(raw, 300) || 'the evaluator gave no usable answer' }
}

/** Whether any assistant message in the slice called a tool. */
export function turnUsedTools(messages: LooseMessage[]): boolean {
  return messages.some(
    m =>
      m.type === 'assistant' &&
      Array.isArray(m.message?.content) &&
      (m.message!.content as LooseBlock[]).some(b => b.type === 'tool_use'),
  )
}

/** Messages after the one with `lastUuid`; all of them when it is unknown. */
export function messagesSince<T extends { uuid?: string }>(messages: T[], lastUuid: string | null): T[] {
  if (!lastUuid) return messages
  const idx = messages.findIndex(m => m.uuid === lastUuid)
  return idx === -1 ? messages : messages.slice(idx + 1)
}
