import { clearCommandsCache, getSkillToolCommands } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { diffSkillNames, formatReloadSkillsMessage } from './diffSkills.js'

const names = (cmds: { name: string }[]) => cmds.map(c => c.name)

export const call: LocalCommandCall = async () => {
  const cwd = getCwd()
  const before = names(await getSkillToolCommands(cwd))
  clearCommandsCache()
  const after = names(await getSkillToolCommands(cwd))
  // The REPL re-fetches its command list (slash menu) on this signal.
  skillChangeDetector.notifyChanged()
  return {
    type: 'text',
    value: formatReloadSkillsMessage(diffSkillNames(before, after)),
  }
}
