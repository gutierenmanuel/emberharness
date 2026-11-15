// Deferred PostToolUse / PostToolUseFailure hooks for backgrounded tool calls.
//
// When a call moves to the background the model receives a synthetic
// tool_result right away and the hooks are skipped on that path (there is no
// real output yet). Once the call settles, toolExecution runs the hooks with
// the real result and the context captured at launch, and the text built here
// is appended to the <task-notification>.
//
// The hooks cannot rewrite the tool result: the model already received the
// synthetic one, and the real result is only reported through the
// notification. An MCP hook's updatedMCPToolOutput is therefore ignored, and
// a blocking error or a stop request is reported as text, not enforced.

export type DeferredHookEvent = 'PostToolUse' | 'PostToolUseFailure'

export const DEFERRED_HOOKS_SECTION_TITLE = 'PostToolUse hooks'

type HookAttachmentLike = {
  type?: unknown
  content?: unknown
  message?: unknown
  blockingError?: unknown
  stderr?: unknown
  hookName?: unknown
}

function attachmentOf(update: unknown): HookAttachmentLike | undefined {
  if (!update || typeof update !== 'object') return undefined
  const message = (update as { message?: unknown }).message
  if (!message || typeof message !== 'object') return undefined
  const m = message as { type?: unknown; attachment?: unknown }
  if (m.type !== 'attachment' || !m.attachment || typeof m.attachment !== 'object') {
    return undefined
  }
  return m.attachment as HookAttachmentLike
}

function blockingErrorText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const inner = (value as { blockingError?: unknown }).blockingError
    if (typeof inner === 'string') return inner
  }
  return String(value)
}

/**
 * Lines worth showing the model from the hook updates yielded by
 * runPostToolUseHooks / runPostToolUseFailureHooks. Progress, success and
 * permission updates carry nothing for the model and are dropped.
 */
export function formatDeferredHookLines(updates: readonly unknown[]): string[] {
  const lines: string[] = []
  for (const update of updates) {
    const att = attachmentOf(update)
    if (!att) continue
    const name = typeof att.hookName === 'string' ? att.hookName : 'hook'
    switch (att.type) {
      case 'hook_additional_context': {
        const parts = Array.isArray(att.content) ? att.content : [att.content]
        for (const part of parts) {
          if (typeof part === 'string' && part.trim()) {
            lines.push(`[${name}] additional context: ${part.trim()}`)
          }
        }
        break
      }
      case 'hook_blocking_error':
        lines.push(
          `[${name}] blocking error: ${blockingErrorText(att.blockingError)}`,
        )
        break
      case 'hook_stopped_continuation':
        lines.push(`[${name}] requested to stop: ${String(att.message ?? '')}`)
        break
      case 'hook_system_message':
        if (typeof att.content === 'string' && att.content.trim()) {
          lines.push(`[${name}] message: ${att.content.trim()}`)
        }
        break
      case 'hook_error_during_execution':
        lines.push(`[${name}] hook error: ${String(att.content ?? '')}`)
        break
      case 'hook_non_blocking_error':
        lines.push(
          `[${name}] non-blocking error: ${String(att.stderr ?? '').trim()}`,
        )
        break
      case 'hook_cancelled':
        lines.push(`[${name}] cancelled`)
        break
      default:
        break
    }
  }
  return lines
}

/** The notification section for a set of hook lines, or undefined when empty. */
export function buildDeferredHooksSection(
  event: DeferredHookEvent,
  lines: readonly string[],
): string | undefined {
  if (lines.length === 0) return undefined
  return `${DEFERRED_HOOKS_SECTION_TITLE} (${event}, run after the call finished in the background; they cannot change the result above):\n${lines.join('\n')}`
}

/**
 * Drain a hook generator and build its notification section. Never throws:
 * a failing hook run becomes a line in the section so the notification is
 * still delivered.
 */
export async function collectDeferredHooksSection(
  event: DeferredHookEvent,
  run: () => AsyncIterable<unknown>,
): Promise<string | undefined> {
  const updates: unknown[] = []
  let failure: string | undefined
  try {
    for await (const update of run()) updates.push(update)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const lines = formatDeferredHookLines(updates)
  if (failure !== undefined) lines.push(`[${event}] hooks failed to run: ${failure}`)
  return buildDeferredHooksSection(event, lines)
}
