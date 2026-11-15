// End-of-turn hook for subagents with background tool calls.
//
// When a subagent's model answers without tool_use, the query loop would
// return and runAgent's cleanup would kill any local_tool task the agent
// still has running. Instead the loop calls collectSubagentBackgroundWork:
// it waits (bounded by a per-loop deadline, FNHARNESS_SUBAGENT_BG_WAIT_MS)
// for those tasks to finish and returns their <task-notification>s as
// attachments, so the loop can run one more turn with the real results.
// Notifications that already landed while the model was generating are
// picked up too, even when nothing is left running.

import type { AppState } from '../state/AppState.js'
import {
  getSubagentBgWaitMs,
  waitForAgentBackgroundTasks,
} from '../tasks/LocalToolTask/agentBackgroundWait.js'
import { isLocalToolTaskNotification } from '../tasks/LocalToolTask/LocalToolTask.js'
import type { AgentId } from '../types/ids.js'
import type { AttachmentMessage } from '../types/message.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  createAttachmentMessage,
  getQueuedCommandAttachments,
} from '../utils/attachments.js'
import { logForDebugging } from '../utils/debug.js'
import { getCommandsByMaxPriority } from '../utils/messageQueueManager.js'

export type SubagentBackgroundWork = {
  messages: AttachmentMessage[]
  /** Queue entries turned into `messages`; the caller removes them from the queue. */
  consumed: QueuedCommand[]
}

/** Queued local_tool notifications addressed to this agent. */
export function getQueuedLocalToolNotificationsForAgent(
  agentId: AgentId,
): QueuedCommand[] {
  return getCommandsByMaxPriority('later').filter(
    cmd => cmd.agentId === agentId && isLocalToolTaskNotification(cmd),
  )
}

/**
 * @param deadline absolute ms timestamp shared across the whole agent loop,
 *   so repeated end-of-turn waits never add up past the cap.
 * @returns null when there is nothing to hand back to the model.
 */
export async function collectSubagentBackgroundWork(opts: {
  agentId: AgentId
  getAppState: () => AppState
  signal: AbortSignal
  deadline: number
}): Promise<SubagentBackgroundWork | null> {
  const { agentId, getAppState, signal, deadline } = opts
  const result = await waitForAgentBackgroundTasks({
    agentId,
    getAppState,
    signal,
    timeoutMs: Math.max(0, deadline - Date.now()),
  })
  if (result.waitedFor.length > 0) {
    logForDebugging(
      `[query] subagent ${agentId} waited for background tasks ${result.waitedFor.join(', ')}` +
        (result.timedOut
          ? ` (timed out; still running: ${result.stillRunning.join(', ')})`
          : result.aborted
            ? ' (aborted)'
            : ''),
    )
  }
  if (signal.aborted) return null
  const consumed = getQueuedLocalToolNotificationsForAgent(agentId)
  if (consumed.length === 0) return null
  const attachments = await getQueuedCommandAttachments(consumed)
  return { messages: attachments.map(a => createAttachmentMessage(a)), consumed }
}

/** Absolute deadline for a loop that starts waiting now. */
export function computeSubagentBgWaitDeadline(now = Date.now()): number {
  return now + getSubagentBgWaitMs()
}
