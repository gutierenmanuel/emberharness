import {
  getAutoCompactThreshold,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import {
  describeAutoCompact,
  getAutoCompactOverride,
  parseAutoCompactArg,
  setAutoCompactOverride,
} from '../../services/compact/autoCompactOverride.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (args, context) => {
  const parsed = parseAutoCompactArg(args)
  if (!parsed.ok) return { type: 'text', value: parsed.error }
  if (parsed.value) setAutoCompactOverride(parsed.value)
  const model = context.options.mainLoopModel
  return {
    type: 'text',
    value: describeAutoCompact(
      getAutoCompactOverride(),
      getAutoCompactThreshold(model),
      isAutoCompactEnabled(),
    ),
  }
}
