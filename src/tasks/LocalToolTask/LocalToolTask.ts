// LocalToolTask: a generic tool call (MCP, WebFetch, WebSearch, ...) that was
// moved to the background with Ctrl+B or by the auto-background timer.
//
// Lifecycle (driven by runBackgroundableToolCall in runBackgroundable.ts):
//   1. A running call registers as a FOREGROUND task after a short delay so
//      Ctrl+B (backgroundAll) can target it; fast calls never register.
//   2. backgroundLocalToolTask() flips isBackgrounded and resolves the
//      background signal that the tool-execution race is waiting on.
//   3. The detached promise later calls completeLocalToolTask(), which writes
//      the final result to the task output file and enqueues a
//      <task-notification> for the model.
//   4. killLocalToolTask() (TaskStop, the tasks dialog) aborts the call.

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  appendTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'

/** Prefix of the synthetic tool_result the model receives when a call is backgrounded. The UI matches on it. */
export const BACKGROUND_TOOL_RESULT_PREFIX = 'Tool call moved to the background'

export type LocalToolTaskState = TaskStateBase & {
  type: 'local_tool'
  /** Tool name as the model called it (e.g. mcp__server__tool, WebFetch). */
  toolName: string
  /** false while the turn is still awaiting the call (Ctrl+B target). */
  isBackgrounded: boolean
  agentId?: AgentId
  /** Aborts the underlying tool call. Not serializable; dropped on completion. */
  abortController?: AbortController
}

export function isLocalToolTask(task: unknown): task is LocalToolTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    (task as { type: unknown }).type === 'local_tool'
  )
}

// Background signals: the tool-execution race awaits the promise; Ctrl+B and
// the auto-background timer resolve it. Same pattern as LocalAgentTask.
const backgroundSignalResolvers = new Map<string, () => void>()
const backgroundSignals = new Map<string, Promise<void>>()

/** Create (or return) the background signal for a task id. */
export function getLocalToolBackgroundSignal(taskId: string): Promise<void> {
  let signal = backgroundSignals.get(taskId)
  if (!signal) {
    signal = new Promise<void>(resolve => {
      backgroundSignalResolvers.set(taskId, resolve)
    })
    backgroundSignals.set(taskId, signal)
  }
  return signal
}

export function clearLocalToolBackgroundSignal(taskId: string): void {
  backgroundSignalResolvers.delete(taskId)
  backgroundSignals.delete(taskId)
}

export function registerForegroundLocalToolTask(
  input: {
    taskId: string
    toolName: string
    description: string
    toolUseId?: string
    agentId?: AgentId
    abortController: AbortController
  },
  setAppState: SetAppState,
): void {
  const state: LocalToolTaskState = {
    ...createTaskStateBase(
      input.taskId,
      'local_tool',
      input.description,
      input.toolUseId,
    ),
    type: 'local_tool',
    status: 'running',
    toolName: input.toolName,
    isBackgrounded: false,
    agentId: input.agentId,
    abortController: input.abortController,
  }
  registerTask(state, setAppState)
}

/**
 * Move a registered foreground tool task to the background.
 * @returns true if the task was foreground and is now backgrounded.
 */
export function backgroundLocalToolTask(
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppState,
): boolean {
  const task = getAppState().tasks[taskId]
  if (
    !isLocalToolTask(task) ||
    task.isBackgrounded ||
    task.status !== 'running'
  ) {
    return false
  }
  updateTaskState<LocalToolTaskState>(taskId, setAppState, t =>
    t.isBackgrounded ? t : { ...t, isBackgrounded: true },
  )
  const resolve = backgroundSignalResolvers.get(taskId)
  if (resolve) {
    resolve()
    backgroundSignalResolvers.delete(taskId)
  }
  return true
}

/** True if some local_tool task is running in the foreground. */
export function hasForegroundLocalToolTasks(state: AppState): boolean {
  return Object.values(state.tasks).some(
    t => isLocalToolTask(t) && !t.isBackgrounded && t.status === 'running',
  )
}

/** Background every foreground local_tool task (Ctrl+B). */
export function backgroundAllLocalToolTasks(
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const ids = Object.keys(getAppState().tasks).filter(id => {
    const t = getAppState().tasks[id]
    return isLocalToolTask(t) && !t.isBackgrounded && t.status === 'running'
  })
  for (const id of ids) backgroundLocalToolTask(id, getAppState, setAppState)
}

/** Remove a task that finished without being backgrounded (or raced with backgrounding). */
export function removeLocalToolTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => {
    if (!isLocalToolTask(prev.tasks[taskId])) return prev
    const { [taskId]: _removed, ...rest } = prev.tasks
    return { ...prev, tasks: rest }
  })
  clearLocalToolBackgroundSignal(taskId)
}

/** One line per progress event, appended to the task output file. */
export function formatToolProgressLine(data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (d.type === 'mcp_progress') {
      const parts: string[] = [`[mcp ${String(d.status ?? 'progress')}]`]
      if (typeof d.progress === 'number') {
        parts.push(
          typeof d.total === 'number'
            ? `${d.progress}/${d.total}`
            : String(d.progress),
        )
      }
      if (typeof d.progressMessage === 'string' && d.progressMessage) {
        parts.push(d.progressMessage)
      }
      return parts.join(' ')
    }
  }
  let text: string
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data)
  } catch {
    text = String(data)
  }
  if (text === undefined) text = String(data)
  const MAX = 2_000
  return `[progress] ${text.length > MAX ? `${text.slice(0, MAX)}…` : text}`
}

export function appendLocalToolOutput(taskId: string, text: string): void {
  appendTaskOutput(taskId, text.endsWith('\n') ? text : `${text}\n`)
}

const NOTIFICATION_PREVIEW_CHARS = 2_000

function enqueueLocalToolNotification(
  task: LocalToolTaskState,
  status: 'completed' | 'failed' | 'killed',
  preview: string | undefined,
): void {
  const outputPath = getTaskOutputPath(task.id)
  const toolUseIdLine = task.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${task.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const verb =
    status === 'completed'
      ? 'completed'
      : status === 'failed'
        ? 'failed'
        : 'was stopped'
  const summary = `Background tool ${task.toolName} "${task.description}" ${verb}`
  let message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${task.id}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>local_tool</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
  if (preview) {
    const truncated = preview.length > NOTIFICATION_PREVIEW_CHARS
    message += `\nResult${truncated ? ' (truncated, full result in the output file)' : ''}:\n${truncated ? `${preview.slice(0, NOTIFICATION_PREVIEW_CHARS)}…` : preview}`
  }
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'next',
    agentId: task.agentId,
  })
}

/**
 * Atomically claim the right to notify (notified false → true).
 * Returns the task snapshot when this caller should notify.
 */
function claimNotification(
  taskId: string,
  setAppState: SetAppState,
  next: Partial<LocalToolTaskState>,
): LocalToolTaskState | undefined {
  let claimed: LocalToolTaskState | undefined
  updateTaskState<LocalToolTaskState>(taskId, setAppState, t => {
    if (t.notified) return t
    const updated = { ...t, ...next, notified: true }
    claimed = updated
    return updated
  })
  return claimed
}

/**
 * Record the outcome of a backgrounded call: write the result to the output
 * file, mark the task terminal and notify the model. No-op if the task was
 * already killed/notified.
 */
export async function completeLocalToolTask(
  taskId: string,
  outcome:
    | { status: 'completed'; resultText: string }
    | { status: 'failed'; error: string },
  getAppState: () => AppState,
  setAppState: SetAppState,
): Promise<void> {
  clearLocalToolBackgroundSignal(taskId)
  const current = getAppState().tasks[taskId]
  if (!isLocalToolTask(current) || current.notified) {
    return
  }
  const body =
    outcome.status === 'completed'
      ? `--- result ---\n${outcome.resultText}`
      : `--- error ---\n${outcome.error}`
  appendLocalToolOutput(taskId, body)
  await flushTaskOutput(taskId)
  const task = claimNotification(taskId, setAppState, {
    status: outcome.status,
    endTime: Date.now(),
    abortController: undefined,
  })
  if (task) {
    enqueueLocalToolNotification(
      task,
      outcome.status,
      outcome.status === 'completed' ? outcome.resultText : outcome.error,
    )
  }
  void evictTaskOutput(taskId)
}

/** Stop a running tool task (TaskStop, tasks dialog). */
export function killLocalToolTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  let controller: AbortController | undefined
  let killed: LocalToolTaskState | undefined
  updateTaskState<LocalToolTaskState>(taskId, setAppState, t => {
    if (t.status !== 'running') return t
    controller = t.abortController
    const updated: LocalToolTaskState = {
      ...t,
      status: 'killed',
      endTime: Date.now(),
      abortController: undefined,
      notified: true,
    }
    // A foreground call that is stopped reports through its own tool_result
    // (runBackgroundableToolCall returns kind 'stopped'), so only a
    // backgrounded one needs a <task-notification>.
    killed = t.notified || !t.isBackgrounded ? undefined : updated
    return updated
  })
  // Resolve the race first: a foreground task that is stopped must release
  // the turn even if the tool ignores the abort signal.
  const resolve = backgroundSignalResolvers.get(taskId)
  if (resolve) {
    resolve()
    backgroundSignalResolvers.delete(taskId)
  }
  controller?.abort('task_stop')
  if (killed) {
    appendLocalToolOutput(taskId, '--- stopped ---')
    enqueueLocalToolNotification(killed, 'killed', undefined)
    void evictTaskOutput(taskId)
  }
}

export const LocalToolTask: Task = {
  name: 'LocalToolTask',
  type: 'local_tool',
  async kill(taskId, setAppState) {
    killLocalToolTask(taskId, setAppState)
  },
}
