/**
 * Pure restart policy for MCP servers that die by themselves. Used for local
 * (stdio) servers, which Claude Code leaves `failed` until the user reconnects
 * by hand; remote transports keep their own loop in useManageMCPConnections.
 *
 * Anti crash-loop rule: attempts accumulate while the process keeps dying
 * quickly. Only a process that stayed up for `STABLE_UPTIME_MS` is considered
 * healthy again and gets a fresh budget, so a server that crashes on start
 * gives up after `STDIO_MAX_ATTEMPTS` tries instead of flapping forever.
 */

export const STDIO_MAX_ATTEMPTS = 4
export const INITIAL_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 30_000
export const STABLE_UPTIME_MS = 60_000

/** Delay before attempt number `attempt` (1-based): 1 s, 2 s, 4 s ... capped. */
export function nextBackoffMs(
  attempt: number,
  initialMs = INITIAL_BACKOFF_MS,
  maxMs = MAX_BACKOFF_MS,
): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(initialMs * 2 ** (n - 1), maxMs)
}

export type RestartState = {
  /** Restart attempts used since the process last proved stable. */
  attempts: number
  /** When the current process connected; null while it is not connected. */
  connectedAt: number | null
}

export const INITIAL_RESTART_STATE: RestartState = { attempts: 0, connectedAt: null }

export type RestartDecision =
  | { action: 'retry'; attempt: number; delayMs: number; next: RestartState }
  | { action: 'give-up'; attempts: number; next: RestartState }

/**
 * Decides what to do when the process died at `now`. `next` is the state to
 * store (the caller records `connectedAt` again when the new process connects).
 */
export function decideStdioRestart(
  state: RestartState,
  now: number,
  maxAttempts = STDIO_MAX_ATTEMPTS,
): RestartDecision {
  const stable =
    state.connectedAt !== null && now - state.connectedAt >= STABLE_UPTIME_MS
  const used = stable ? 0 : state.attempts
  const attempt = used + 1
  if (attempt > maxAttempts) {
    return {
      action: 'give-up',
      attempts: used,
      next: { attempts: used, connectedAt: null },
    }
  }
  return {
    action: 'retry',
    attempt,
    delayMs: nextBackoffMs(attempt),
    next: { attempts: attempt, connectedAt: null },
  }
}

/** Short toast text for the restart lifecycle. */
export function formatRestartNotice(
  name: string,
  decision: RestartDecision,
  maxAttempts = STDIO_MAX_ATTEMPTS,
): string {
  return decision.action === 'retry'
    ? `MCP: ${name} stopped, restarting (${decision.attempt}/${maxAttempts})`
    : `MCP: ${name} keeps crashing, gave up after ${decision.attempts} restarts · /mcp reconnect ${name}`
}
