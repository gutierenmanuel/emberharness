import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { which } from '../../utils/which.js'
import {
  deliverPushNotification,
  describeDelivery,
  isPushNotificationEnabled,
  MAX_MESSAGE_CHARS,
  MAX_TITLE_CHARS,
  PUSH_NOTIFICATION_TOOL_NAME,
} from './pushNotification.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .min(1)
      .describe(
        `What the user should know, in one short line (max ${MAX_MESSAGE_CHARS} characters). Lead with what they need to act on.`,
      ),
    title: z
      .string()
      .optional()
      .describe(`Optional short title (max ${MAX_TITLE_CHARS} characters).`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    channel: z.enum(['desktop', 'tui', 'none']),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type PushNotificationOutput = z.infer<OutputSchema>

const PROMPT = `Send the user a desktop notification. Use it sparingly: when a long task finished or something needs their decision and they may be away from the terminal. Do not use it for routine progress.

The notification is local and silent: it goes through the desktop notifier (notify-send) when the machine has one, otherwise it appears as a notice in the terminal UI. Keep the message to one short line.`

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'send the user a desktop notification',
  maxResultSizeChars: 2_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isPushNotificationEnabled(getInitialSettings())
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async description() {
    return 'Send the user a local, silent desktop notification'
  },
  async prompt() {
    return PROMPT
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  getActivityDescription() {
    return 'Notifying the user'
  },
  async call(input, context) {
    const delivery = await deliverPushNotification(input, {
      which,
      exec: async (file, args) => ({
        code: (await execFileNoThrow(file, args, { timeout: 5_000, useCwd: false })).code,
      }),
      showInTui: context.addNotification
        ? text =>
            context.addNotification!({
              key: 'push-notification',
              text,
              priority: 'high',
              timeoutMs: 15_000,
            })
        : undefined,
    })
    return {
      data: { channel: delivery.channel, message: describeDelivery(delivery) },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: output.message }
  },
  renderToolUseMessage(input: Partial<{ message: string }>) {
    return input.message ?? ''
  },
  renderToolResultMessage(output: PushNotificationOutput) {
    return output.message
  },
} satisfies ToolDef<InputSchema, PushNotificationOutput>)
