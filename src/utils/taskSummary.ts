/**
 * Periodic task summary hook called from query.ts when BG_SESSIONS is on.
 *
 * Upstream fills the `ps` activity column with an LLM-written summary. Here
 * `fnharness ps` shows the launch prompt instead, so no extra model call is
 * made: both functions are deliberate no-ops that keep the call site compiling.
 */
export function shouldGenerateTaskSummary(): boolean {
  return false
}

export function maybeGenerateTaskSummary(_params: Record<string, unknown>): void {}
