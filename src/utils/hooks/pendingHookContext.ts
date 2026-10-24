/**
 * Context returned by hooks that run outside a model request (PostModelSwitch)
 * and must reach the model with the next one. Queued here, drained once as a
 * `hook_additional_context` attachment on the next main-thread turn. Per the
 * official event, only the output of the last switch survives.
 */

type Pending = { hookEvent: 'PostModelSwitch'; content: string[] }

let pending: Pending | undefined

export function queuePendingHookContext(
  hookEvent: Pending['hookEvent'],
  content: string[],
): void {
  // A newer switch replaces the previous one even when it adds nothing.
  pending = content.length > 0 ? { hookEvent, content } : undefined
}

export function takePendingHookContext(): Pending | undefined {
  const p = pending
  pending = undefined
  return p
}
