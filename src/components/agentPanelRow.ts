/**
 * Pure layout of one row of the subagent panel under the prompt, shaped like
 * Claude Code 2.1.310 plus the account and resolved model of every agent:
 *
 *   ◯ lab-operator · zcode:glm-5.3-flash · Mapa mejoras NVIDIA…     7s · ↓ 16.9k tokens
 *
 * Name, alias, account and model are never truncated (also when the account
 * is the session's); the description takes whatever room is left. The
 * account label is added after the model only when the description keeps
 * enough room.
 *
 * Bullet: ◯ idle row, ● the row being viewed; ❯ replaces the leading blanks on
 * the selected row. Time and tokens are right aligned.
 */

export type AgentRowInput = {
  /** Agent type shown in bold (Explore, general-purpose...). Falls back to the name. */
  label: string
  /** Name or alias the agent was given (SendMessage `to`), shown after the label when it differs. */
  alias?: string
  /** Resolved `cuenta:modelo` the agent runs on (agentModelSpec). */
  model?: string
  /** Human label of that account, shown only when it fits. */
  accountLabel?: string
  /** Legacy: account shown as [cuenta] when no model is known. */
  account?: string
  description: string
  selected: boolean
  viewed: boolean
  running: boolean
  elapsed: string
  /** Already formatted, e.g. "16.9k"; empty or undefined hides the token part. */
  tokens?: string
  /** True while generating (shows ↓), false for outbound/idle (shows ↑). */
  receiving?: boolean
  queued?: number
  columns: number
  /** Terminal width the panel cannot use on the right (paddings). */
  margin?: number
}

export type AgentRowParts = {
  head: string
  description: string
  gap: string
  right: string
  hint: string
}

export function selectionHint(running: boolean, viewed: boolean): string {
  if (viewed) return ''
  return `Enter to view · x to ${running ? 'stop' : 'clear'}`
}

/** Description columns the account label never takes away. */
const MIN_DESCRIPTION_FOR_LABEL = 24

/**
 * Pure: the `cuenta:modelo` an agent runs on. A routed agent shows its
 * account and model; an unrouted one runs on the session's account with its
 * resolved model. Undefined when the model is unknown.
 */
export function agentModelSpec(
  model: string | undefined,
  routed: { accountId: string; model: string } | null,
  sessionAccount: string,
): string | undefined {
  if (routed) return `${routed.accountId}:${routed.model}`
  if (!model) return undefined
  return `${sessionAccount}:${model}`
}

export function layoutAgentRow(
  i: AgentRowInput,
  width: (s: string) => number,
  truncate: (s: string, max: number) => string,
): AgentRowParts {
  const prefix = i.selected ? '❯ ' : '  '
  const bullet = i.viewed ? '●' : '◯'
  const alias = i.alias && i.alias !== i.label ? ` (${i.alias})` : ''
  const where = i.model ? ` · ${i.model}` : i.account ? ` [${i.account}]` : ''
  const sep = i.model ? ' · ' : '  '
  const arrow = i.receiving === false ? '↑' : '↓'
  const tokenText = i.tokens ? ` · ${arrow} ${i.tokens} tokens` : ''
  const queuedText = i.queued && i.queued > 0 ? ` · ${i.queued} queued` : ''
  const hint = i.selected ? selectionHint(i.running, i.viewed) : ''
  const right = `${i.elapsed}${tokenText}${queuedText}`
  const hintPart = hint ? ` · ${hint}` : ''
  const total = Math.max(0, i.columns - (i.margin ?? 2))
  const roomFor = (h: string) => Math.max(0, total - (width(h) + width(sep) + width(right) + width(hintPart) + 2))
  let head = `${prefix}${bullet} ${i.label}${alias}${where}`
  const labelled = i.model && i.accountLabel ? `${head} (${i.accountLabel})` : head
  if (labelled !== head && roomFor(labelled) >= Math.min(MIN_DESCRIPTION_FOR_LABEL, width(i.description))) head = labelled
  const description = truncate(i.description, roomFor(head))
  const used = width(head) + width(sep) + width(description) + width(right) + width(hintPart)
  const gap = ' '.repeat(Math.max(2, total - used))
  return { head, description: sep + description, gap, right: right + hintPart, hint: hintPart }
}
