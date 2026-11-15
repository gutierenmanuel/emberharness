// Wait for a subagent's background work before letting it finish.
//
// A subagent's tool call can be auto-backgrounded (local_tool task). If the
// subagent then answers without tool_use, its query loop would end and
// runAgent's cleanup would kill the call, so the agent hands its parent a
// report without the result it asked for. The query loop calls
// waitForAgentBackgroundTasks at that point, then drains the resulting
// <task-notification>s and runs one more turn.
//
// The predicate is pluggable so the same wait can cover other task types
// later. Today only local_tool tasks are waited for: shell tasks started with
// run_in_background are often long-lived servers or watchers, and waiting on
// them would change how subagents that use them behave.

import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import { isLocalToolTask } from './LocalToolTask.js'

export const SUBAGENT_BG_WAIT_ENV = 'FNHARNESS_SUBAGENT_BG_WAIT_MS'

/** Default cap (10 min) on how long a subagent waits for its background tool calls. */
export const DEFAULT_SUBAGENT_BG_WAIT_MS = 600_000

const DEFAULT_POLL_MS = 250

/**
 * Wait cap in ms from FNHARNESS_SUBAGENT_BG_WAIT_MS. 0 (or negative)
 * disables the wait; unset or unparsable falls back to the default.
 */
export function getSubagentBgWaitMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[SUBAGENT_BG_WAIT_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUBAGENT_BG_WAIT_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_SUBAGENT_BG_WAIT_MS
  return n <= 0 ? 0 : Math.floor(n)
}

export type WaitableTaskPredicate = (task: unknown, agentId: AgentId) => boolean

/** Default predicate: a running, backgrounded local_tool task of this agent. */
export function isWaitableAgentBackgroundTask(
  task: unknown,
  agentId: AgentId,
): boolean {
  return (
    isLocalToolTask(task) &&
    task.agentId === agentId &&
    task.status === 'running' &&
    task.isBackgrounded
  )
}

export function getWaitableBackgroundTaskIds(
  state: AppState,
  agentId: AgentId,
  isWaitable: WaitableTaskPredicate = isWaitableAgentBackgroundTask,
): string[] {
  return Object.entries(state.tasks ?? {})
    .filter(([, task]) => isWaitable(task, agentId))
    .map(([id]) => id)
}

export type AgentBackgroundWaitResult = {
  /** Tasks that were running when the wait started. */
  waitedFor: string[]
  /** Tasks still running when the wait returned (timeout or abort). */
  stillRunning: string[]
  timedOut: boolean
  aborted: boolean
}

/**
 * Resolve once none of the agent's waitable tasks is running, the timeout
 * elapses or the signal aborts. Returns immediately (waitedFor empty) when
 * there is nothing to wait for or timeoutMs <= 0.
 */
export async function waitForAgentBackgroundTasks(opts: {
  agentId: AgentId
  getAppState: () => AppState
  timeoutMs: number
  signal?: AbortSignal
  pollMs?: number
  isWaitable?: WaitableTaskPredicate
}): Promise<AgentBackgroundWaitResult> {
  const { agentId, getAppState, timeoutMs, signal } = opts
  const isWaitable = opts.isWaitable ?? isWaitableAgentBackgroundTask
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const running = () =>
    getWaitableBackgroundTaskIds(getAppState(), agentId, isWaitable)

  const waitedFor = running()
  if (waitedFor.length === 0 || timeoutMs <= 0 || signal?.aborted) {
    return {
      waitedFor,
      stillRunning: waitedFor,
      timedOut: false,
      aborted: signal?.aborted ?? false,
    }
  }

  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (timedOut: boolean, aborted: boolean) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ waitedFor, stillRunning: running(), timedOut, aborted })
    }
    const onAbort = () => finish(false, true)
    signal?.addEventListener('abort', onAbort, { once: true })
    const tick = () => {
      if (running().length === 0) return finish(false, false)
      const left = deadline - Date.now()
      if (left <= 0) return finish(true, false)
      timer = setTimeout(tick, Math.min(pollMs, left))
    }
    tick()
  })
}
