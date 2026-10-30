import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { sessionAgentModel, validateAgentModelParam } from '../model/routedModels.js'
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
  // The Agent tool needs cuenta:modelo; without --model the agent stays on the session's.
  const model = parsed.model ?? sessionAgentModel()
  const modelError = validateAgentModelParam(model)
  if (modelError) {
    onDone(modelError, { display: 'system' })
    return null
  }
  onDone(`Lanzando /${mode} en segundo plano: ${parsed.directive}`, {
    display: 'system',
    shouldQuery: true,
    metaMessages: [buildSubagentPrompt(mode, parsed.directive, model)],
  })
  return null
}
