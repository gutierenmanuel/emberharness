/**
 * Subagents must always answer their parent. The parent only sees the
 * subagent's final text, so a turn that ends with no text (common with local
 * models that stop right after their last tool result) leaves it with nothing.
 * The query loop then asks once for the report before letting the agent end.
 */

export const FINAL_REPORT_NUDGE =
  'You ended your turn without writing anything, but the agent that launched you only sees your final text message. ' +
  'Reply now with your final report: what you did, what you found or changed, and anything left undone or uncertain. ' +
  'Do not call tools unless something essential is missing.'

type MaybeAssistant = {
  type: string
  message?: { content?: unknown }
}

/** True when none of these assistant messages carries non-blank text. */
export function lacksFinalText(assistantMessages: readonly MaybeAssistant[]): boolean {
  for (const m of assistantMessages) {
    if (m.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: string; text?: unknown }[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        return false
      }
    }
  }
  return true
}

/** Whether a query loop belongs to a subagent that answers a parent. */
export function isParentReportingQuery(
  querySource: string,
  agentId: string | undefined,
  isTeammate: boolean,
): boolean {
  return agentId !== undefined && !isTeammate && querySource.startsWith('agent:')
}
