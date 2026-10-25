import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { validateAgentModelParam } from '../model/routedModels.js'
import {
  buildSubagentPrompt,
  parseSubagentArgs,
  type SubagentMode,
} from './subagentCommandLogic.js'

/** Shared body of `/fork` and `/subtask`: validate, then ask the model to call Agent. */
export async function runSubagentCommand(
  mode: SubagentMode,
  onDone: LocalJSXCommandOnDone,
  args: string,
): Promise<null> {
  const parsed = parseSubagentArgs(args, mode)
  if (parsed.kind === 'error') {
    onDone(parsed.message, { display: 'system' })
    return null
  }
  const modelError = validateAgentModelParam(parsed.model ?? undefined)
  if (modelError) {
    onDone(modelError, { display: 'system' })
    return null
  }
  onDone(`Lanzando /${mode} en segundo plano: ${parsed.directive}`, {
    display: 'system',
    shouldQuery: true,
    metaMessages: [buildSubagentPrompt(mode, parsed.directive, parsed.model)],
  })
  return null
}
