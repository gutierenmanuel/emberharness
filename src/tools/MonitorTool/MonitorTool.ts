import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import {
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AgentId } from '../../types/ids.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { exec } from '../../utils/Shell.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { escapeXml } from '../../utils/xml.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'
import {
  clampMonitorTimeout,
  compileLineFilter,
  createMonitorLineProcessor,
  formatMonitorBatch,
  MONITOR_MAX_TIMEOUT_MS,
} from './monitorLines.js'
import {
  MONITOR_DESCRIPTION,
  MONITOR_PROMPT,
  MONITOR_TOOL_NAME,
} from './prompt.js'
import { renderMonitorResultMessage, renderMonitorToolUseMessage } from './UI.js'

/** How often buffered lines are flushed into one notification. */
const FLUSH_INTERVAL_MS = 400

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .describe(
        'Shell command to run in the background. Every line it prints to stdout becomes an event, so print one line per event worth reacting to.',
      ),
    description: z
      .string()
      .describe(
        'Short label for what is being watched, e.g. "errors in app.log". Shown to the user and in each event.',
      ),
    timeout_ms: semanticNumber(z.number().optional()).describe(
      `Deadline in milliseconds (default 300000, max ${MONITOR_MAX_TIMEOUT_MS}). The watch ends there.`,
    ),
    persistent: semanticBoolean(z.boolean().optional()).describe(
      'true = no deadline: run until the session ends or TaskStop.',
    ),
    include: z
      .string()
      .optional()
      .describe('Optional regex: only lines matching it are delivered.'),
    exclude: z
      .string()
      .optional()
      .describe('Optional regex: lines matching it are skipped.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string(),
    description: z.string(),
    timeoutMs: z.number(),
    persistent: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type MonitorOutput = z.infer<OutputSchema>

function enqueueMonitorMessage(
  taskId: string,
  toolUseId: string | undefined,
  summary: string,
  event: string | null,
  agentId: AgentId | undefined,
): void {
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  // No <status> tag: print.ts treats statusless notifications as progress pings.
  const eventBlock = event === null ? '' : `\n<event>${escapeXml(event)}</event>`
  enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>${eventBlock}
</${TASK_NOTIFICATION_TAG}>`,
    mode: 'task-notification',
    priority: 'next',
    agentId,
  })
}

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'watch a command output and react to each line',
  maxResultSizeChars: 10_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  },
  userFacingName() {
    return 'Monitor'
  },
  async description() {
    return MONITOR_DESCRIPTION
  },
  async prompt() {
    return MONITOR_PROMPT
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  getActivityDescription(input) {
    return input?.description ? `Monitoring ${input.description}` : 'Starting monitor'
  },
  getToolUseSummary(input) {
    return input?.description ?? null
  },
  async validateInput(input): Promise<ValidationResult> {
    if (input.command.trim() === '') {
      return { result: false, message: 'command must not be empty', errorCode: 1 }
    }
    const f = compileLineFilter(input.include, input.exclude)
    if (!f.ok) return { result: false, message: f.message, errorCode: 2 }
    return { result: true }
  },
  // Same permission rules as Bash: a Monitor runs an arbitrary shell command.
  async checkPermissions(input, context) {
    return bashToolHasPermission(
      { command: input.command, description: input.description } as never,
      context,
    )
  },
  async call(input, context) {
    const setAppState = context.setAppStateForTasks ?? context.setAppState
    const persistent = input.persistent === true
    const timeoutMs = clampMonitorTimeout(input.timeout_ms)
    const compiled = compileLineFilter(input.include, input.exclude)
    if (!compiled.ok) throw new Error(compiled.message)
    const processor = createMonitorLineProcessor(compiled.filter)
    const toolUseId = context.toolUseId
    const agentId = context.agentId as AgentId | undefined
    // Own controller: ending the model's turn must not stop the watch.
    const controller = new AbortController()

    const shellCommand = await exec(input.command, controller.signal, 'bash', {
      // The deadline is enforced below so it can produce its own notice; this
      // only needs to outlive it.
      timeout: MONITOR_MAX_TIMEOUT_MS + 60_000,
      preventCwdChanges: true,
      shouldUseSandbox: false,
      shouldAutoBackground: false,
      onStdout: chunk => processor.push(chunk, Date.now()),
    })
    const handle = await spawnShellTask(
      {
        command: input.command,
        description: input.description,
        shellCommand,
        toolUseId,
        agentId,
        kind: 'monitor',
      },
      {
        abortController: controller,
        getAppState: () => {
          throw new Error('getAppState not available in Monitor')
        },
        setAppState,
      },
    )
    const taskId = handle.taskId
    const label = `Monitor event: "${input.description}"`

    let stopped = false
    const flush = () => {
      for (let b = processor.take(Date.now()); b; b = processor.take(Date.now())) {
        enqueueMonitorMessage(taskId, toolUseId, label, formatMonitorBatch(b), agentId)
      }
      if (!stopped && processor.tooNoisy) {
        stopped = true
        killTask(taskId, setAppState)
        enqueueMonitorMessage(
          taskId,
          toolUseId,
          `Monitor "${input.description}" was stopped: its output is too fast. Start it again with a command that filters to the lines that matter.`,
          null,
          agentId,
        )
      }
    }
    const flusher = setInterval(flush, FLUSH_INTERVAL_MS)
    flusher.unref?.()
    let deadline: ReturnType<typeof setTimeout> | undefined
    if (!persistent) {
      deadline = setTimeout(() => {
        if (stopped) return
        stopped = true
        flush()
        killTask(taskId, setAppState)
        enqueueMonitorMessage(
          taskId,
          toolUseId,
          `Monitor "${input.description}" reached its ${Math.round(timeoutMs / 60000)} minute deadline and was stopped. Start it again if you still need it.`,
          null,
          agentId,
        )
      }, timeoutMs)
      deadline.unref?.()
    }
    // Registered after spawnShellTask's own handler on purpose: flush the last
    // events, then the "stream ended" notice follows.
    void shellCommand.result.then(() => {
      clearInterval(flusher)
      if (deadline) clearTimeout(deadline)
      processor.end(Date.now())
      stopped = true
      flush()
    })

    return {
      data: { taskId, description: input.description, timeoutMs, persistent },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Monitor started (task ${output.taskId}, ${output.persistent ? 'no deadline' : `deadline ${Math.round(output.timeoutMs / 60000)} min`}). Each stdout line will arrive as a notification; you do not need to poll. Stop it with TaskStop using task_id ${output.taskId}. Output is also saved at ${getTaskOutputPath(output.taskId)}.`,
    }
  },
  renderToolUseMessage: renderMonitorToolUseMessage,
  renderToolResultMessage: renderMonitorResultMessage,
} satisfies ToolDef<InputSchema, MonitorOutput>)
