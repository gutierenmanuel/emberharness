// Race a tool call against Ctrl+B / the auto-background timer.
//
// The call runs with its own AbortController: while the call is in the
// foreground, aborting the turn (Esc, interrupt) aborts the call as before;
// once it is backgrounded the turn abort no longer reaches it and only
// TaskStop (killLocalToolTask) can stop it.
//
// Fast calls are untouched: the task is only registered (task_started SDK
// event, Ctrl+B target, output file) after `registerDelayMs`, so a call that
// finishes earlier leaves no trace in AppState or on disk.

import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import { generateTaskId } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { createAbortController } from '../../utils/abortController.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  cleanupTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { TOOL_FOREGROUND_REGISTER_DELAY_MS } from './backgroundable.js'
import {
  appendLocalToolOutput,
  backgroundLocalToolTask,
  BACKGROUND_TOOL_RESULT_PREFIX,
  clearLocalToolBackgroundSignal,
  completeLocalToolTask,
  formatToolProgressLine,
  getLocalToolBackgroundSignal,
  isLocalToolTask,
  registerForegroundLocalToolTask,
  removeLocalToolTask,
} from './LocalToolTask.js'

export type BackgroundableCallOutcome<R> =
  | { kind: 'completed'; result: R }
  | {
      kind: 'backgrounded'
      taskId: string
      outputPath: string
      reason: 'user' | 'auto'
    }
  | { kind: 'stopped'; taskId: string }

export type BackgroundableCallContext = {
  /** Abort controller to hand to the tool instead of the turn's. */
  abortController: AbortController
  /**
   * Record a progress event in the task output file. Returns true while the
   * call is still in the foreground, i.e. when the caller should also
   * forward the event to the turn's progress UI.
   */
  recordProgress: (data: unknown) => boolean
}

export type RunBackgroundableOptions<R> = {
  toolName: string
  description: string
  toolUseId?: string
  agentId?: AgentId
  parentAbortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
  call: (ctx: BackgroundableCallContext) => Promise<R>
  /** Text written to the output file (and notification) once a backgrounded call resolves. */
  formatResult: (result: R) => string
  /**
   * Runs once a backgrounded call settles and before its notification is
   * sent (deferred PostToolUse hooks). The returned text is appended to the
   * output file and the notification. Skipped when the task was stopped;
   * errors are caught and reported in the notification instead.
   */
  afterBackgroundSettled?: (
    settled:
      | { status: 'completed'; result: R }
      | { status: 'failed'; error: unknown },
  ) => Promise<string | undefined>
  /** 0 disables auto-background. */
  autoBackgroundMs: number
  registerDelayMs?: number
}

const MAX_BUFFERED_PROGRESS_LINES = 500

export async function runBackgroundableToolCall<R>(
  opts: RunBackgroundableOptions<R>,
): Promise<BackgroundableCallOutcome<R>> {
  const {
    toolName,
    description,
    toolUseId,
    agentId,
    parentAbortController: parent,
    getAppState,
    setAppState,
    autoBackgroundMs,
  } = opts
  const registerDelayMs = opts.registerDelayMs ?? TOOL_FOREGROUND_REGISTER_DELAY_MS

  const taskId = generateTaskId('local_tool')
  const outputPath = getTaskOutputPath(taskId)
  const child = createAbortController()
  let backgrounded = false
  let registered = false
  let autoTriggered = false

  const onParentAbort = () => {
    if (!backgrounded) child.abort(parent.signal.reason)
  }
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
  } else {
    parent.signal.addEventListener('abort', onParentAbort, { once: true })
  }
  const detachParent = () =>
    parent.signal.removeEventListener('abort', onParentAbort)

  const buffered: string[] = []
  const register = () => {
    if (registered) return
    registered = true
    registerForegroundLocalToolTask(
      {
        taskId,
        toolName,
        description,
        toolUseId,
        agentId,
        abortController: child,
      },
      setAppState,
    )
    appendLocalToolOutput(taskId, `[tool] ${toolName}: ${description}`)
    for (const line of buffered) appendLocalToolOutput(taskId, line)
    buffered.length = 0
  }

  const recordProgress = (data: unknown): boolean => {
    const line = formatToolProgressLine(data)
    if (registered) {
      appendLocalToolOutput(taskId, line)
    } else if (buffered.length < MAX_BUFFERED_PROGRESS_LINES) {
      buffered.push(line)
    }
    return !backgrounded
  }

  const bgSignal = getLocalToolBackgroundSignal(taskId)
  const registerTimer = setTimeout(register, registerDelayMs)
  registerTimer.unref?.()
  const autoTimer =
    autoBackgroundMs > 0
      ? setTimeout(() => {
          register()
          if (backgroundLocalToolTask(taskId, getAppState, setAppState)) {
            autoTriggered = true
          }
        }, autoBackgroundMs)
      : undefined
  autoTimer?.unref?.()

  let callPromise: Promise<R>
  try {
    callPromise = opts.call({ abortController: child, recordProgress })
  } catch (e) {
    callPromise = Promise.reject(e)
  }

  const winner = await Promise.race([
    callPromise.then(
      result => ({ type: 'done' as const, result }),
      error => ({ type: 'error' as const, error: error as unknown }),
    ),
    bgSignal.then(() => ({ type: 'bg' as const })),
  ])
  clearTimeout(registerTimer)
  if (autoTimer) clearTimeout(autoTimer)

  if (winner.type !== 'bg') {
    // Finished in the foreground (possibly racing a Ctrl+B in the same tick):
    // the tool_result carries the output, so drop the task silently.
    detachParent()
    if (registered) {
      removeLocalToolTask(taskId, setAppState)
      void cleanupTaskOutput(taskId)
    } else {
      clearLocalToolBackgroundSignal(taskId)
    }
    if (winner.type === 'error') throw winner.error
    return { kind: 'completed', result: winner.result }
  }

  const task = getAppState().tasks[taskId]
  if (isLocalToolTask(task) && task.status === 'killed') {
    // Stopped (TaskStop / tasks dialog) while still in the foreground.
    detachParent()
    clearLocalToolBackgroundSignal(taskId)
    callPromise.catch(() => {})
    return { kind: 'stopped', taskId }
  }

  backgrounded = true
  detachParent()
  const runAfterSettled = async (
    settled:
      | { status: 'completed'; result: R }
      | { status: 'failed'; error: unknown },
  ): Promise<string | undefined> => {
    if (!opts.afterBackgroundSettled) return undefined
    const current = getAppState().tasks[taskId]
    // Stopped (TaskStop, agent exit): no result to hand to the hooks.
    if (!isLocalToolTask(current) || current.status !== 'running') {
      return undefined
    }
    try {
      return await opts.afterBackgroundSettled(settled)
    } catch (e) {
      logError(e)
      return `PostToolUse hooks failed to run: ${errorMessage(e)}`
    }
  }
  void callPromise.then(
    async result => {
      let resultText: string
      try {
        resultText = opts.formatResult(result)
      } catch (e) {
        resultText = `(could not format tool result: ${errorMessage(e)})`
      }
      const extra = await runAfterSettled({ status: 'completed', result })
      return completeLocalToolTask(
        taskId,
        { status: 'completed', resultText },
        getAppState,
        setAppState,
        extra,
      )
    },
    async error => {
      const extra = await runAfterSettled({ status: 'failed', error })
      return completeLocalToolTask(
        taskId,
        { status: 'failed', error: errorMessage(error) },
        getAppState,
        setAppState,
        extra,
      )
    },
  ).catch(logError)

  return {
    kind: 'backgrounded',
    taskId,
    outputPath,
    reason: autoTriggered ? 'auto' : 'user',
  }
}

/** Text of the synthetic tool_result the model receives for a backgrounded call. */
export function buildBackgroundedToolResultText(
  outcome: Extract<BackgroundableCallOutcome<unknown>, { kind: 'backgrounded' }>,
  autoBackgroundMs: number,
): string {
  const why =
    outcome.reason === 'auto'
      ? `it exceeded the auto-background threshold (${Math.round(autoBackgroundMs / 1000)}s)`
      : 'the user moved it to the background (Ctrl+B)'
  return `${BACKGROUND_TOOL_RESULT_PREFIX} because ${why}. It is still running as task ID: ${outcome.taskId}. Progress and the final result are being written to: ${outcome.outputPath}. You will receive a <task-notification> when it finishes; meanwhile use TaskOutput with this task ID (or tail the file with Monitor) to follow it, or TaskStop to cancel it. Do not call the tool again for the same request.`
}
