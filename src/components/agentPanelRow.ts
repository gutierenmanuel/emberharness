/**
 * Pure layout of one row of the subagent panel under the prompt, shaped like
 * Claude Code 2.1.310:
 *
 *   ◯ Explore  Count .ts files in src/                         7s · ↓ 16.9k tokens
 *
 * Bullet: ◯ idle row, ● the row being viewed; ❯ replaces the leading blanks on
 * the selected row. Time and tokens are right aligned.
 */

export type AgentRowInput = {
  /** Agent type shown in bold (Explore, general-purpose...). Falls back to the name. */
  label: string
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

export function layoutAgentRow(
  i: AgentRowInput,
  width: (s: string) => number,
  truncate: (s: string, max: number) => string,
): AgentRowParts {
  const prefix = i.selected ? '❯ ' : '  '
  const bullet = i.viewed ? '●' : '◯'
  const head = `${prefix}${bullet} ${i.label}`
  const arrow = i.receiving === false ? '↑' : '↓'
  const tokenText = i.tokens ? ` · ${arrow} ${i.tokens} tokens` : ''
  const queuedText = i.queued && i.queued > 0 ? ` · ${i.queued} queued` : ''
  const hint = i.selected ? selectionHint(i.running, i.viewed) : ''
  const right = `${i.elapsed}${tokenText}${queuedText}`
  const hintPart = hint ? ` · ${hint}` : ''
  const total = Math.max(0, i.columns - (i.margin ?? 2))
  const fixed = width(head) + 2 + width(right) + width(hintPart) + 2
  const room = Math.max(0, total - fixed)
  const description = truncate(i.description, room)
  const used = width(head) + 2 + width(description) + width(right) + width(hintPart)
  const gap = ' '.repeat(Math.max(2, total - used))
  return { head, description: '  ' + description, gap, right: right + hintPart, hint: hintPart }
}
