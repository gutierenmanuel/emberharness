import type { LocalJSXCommandCall } from '../../types/command.js'
import { runSubagentCommand } from '../../utils/subagentCommand/runSubagentCommand.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) =>
  runSubagentCommand('subtask', onDone, args)
