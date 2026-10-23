import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  LOOP_SENTINEL,
  validateWakeupInput,
  WAKEUP_MAX_SECONDS,
  WAKEUP_MIN_SECONDS,
} from '../../utils/loopSchedule.js'
import { scheduleWakeup, stopWakeups } from '../../utils/loopWakeup.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import {
  isKairosCronEnabled,
  SCHEDULE_WAKEUP_TOOL_NAME,
} from './prompt.js'
import {
  formatWakeupDelay,
  renderWakeupResultMessage,
  renderWakeupToolUseMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: semanticNumber(z.number().optional()).describe(
      `Seconds until the next iteration. Clamped to [${WAKEUP_MIN_SECONDS}, ${WAKEUP_MAX_SECONDS}]. Required unless stop is true.`,
    ),
    prompt: z
      .string()
      .optional()
      .describe(
        `What to run when the wake-up fires: pass the same /loop input string every iteration (for example "/loop check CI"), or the literal ${LOOP_SENTINEL} when the loop has no user prompt. Required unless stop is true.`,
      ),
    reason: z
      .string()
      .optional()
      .describe(
        'One short sentence on why you chose this delay. It is shown to the user.',
      ),
    stop: semanticBoolean(z.boolean().optional()).describe(
      'true = end the self-paced loop now: cancels the pending wake-up. Use it when the task is complete.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    stopped: z.boolean(),
    id: z.string().optional(),
    delaySeconds: z.number().optional(),
    clamped: z.boolean().optional(),
    reason: z.string().optional(),
    cancelled: z.number().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type WakeupOutput = z.infer<OutputSchema>

const PROMPT = `Reschedule the next iteration of a self-paced /loop. Call this at the end of every iteration of a /loop that has no fixed interval, to choose when it runs again, between ${WAKEUP_MIN_SECONDS} seconds and ${WAKEUP_MAX_SECONDS} seconds from now (values outside that range are clamped). Only one wake-up is pending at a time: a new call replaces the previous one.

Pick short delays while something is actively changing (a build finishing, a PR with fresh activity) and long ones when nothing is pending. Pass the same /loop input as prompt every time so the next firing re-enters the loop; for a /loop with no user prompt pass ${LOOP_SENTINEL}.

When the task is complete or the condition you were waiting for is met, call it with stop: true instead of scheduling another iteration. If an iteration ends without calling this tool, one fallback wake-up is scheduled about 20 minutes later and the loop ends if that iteration does not reschedule either.

The wake-up lives in this session only and appears in CronList as a one-shot task. Do not call this tool for a one-off reminder: use CronCreate with recurring: false.`

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  searchHint: 'schedule the next iteration of a self-paced loop',
  maxResultSizeChars: 10_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return input.stop ? 'stop' : `${input.delaySeconds ?? ''}s: ${input.prompt ?? ''}`
  },
  async description() {
    return 'Schedule the next iteration of a self-paced /loop'
  },
  async prompt() {
    return PROMPT
  },
  async validateInput(input): Promise<ValidationResult> {
    const v = validateWakeupInput(input)
    if (!v.ok) return { result: false, message: v.message, errorCode: 1 }
    return { result: true }
  },
  async call(input) {
    const v = validateWakeupInput(input)
    if (!v.ok) throw new Error(v.message)
    if (v.stop) {
      const cancelled = stopWakeups()
      return { data: { stopped: true, cancelled } }
    }
    const { id } = scheduleWakeup(v.delaySeconds, v.prompt, v.reason)
    return {
      data: {
        stopped: false,
        id,
        delaySeconds: v.delaySeconds,
        clamped: v.clamped,
        ...(v.reason ? { reason: v.reason } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.stopped
        ? 'Loop stopped: the pending wake-up was cancelled.'
        : `Next iteration scheduled in ${formatWakeupDelay(output.delaySeconds ?? 0)} (wake-up ${output.id})${output.clamped ? `. The delay was clamped to the ${WAKEUP_MIN_SECONDS}-${WAKEUP_MAX_SECONDS} second range` : ''}.`,
    }
  },
  renderToolUseMessage: renderWakeupToolUseMessage,
  renderToolResultMessage: renderWakeupResultMessage,
} satisfies ToolDef<InputSchema, WakeupOutput>)
