import { stat } from 'fs/promises'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import type { LocalCommandCall } from '../../types/command.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getProjectPathForConfig, isPathTrusted } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { updateHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { setCwd } from '../../utils/Shell.js'
import { parseCdArgs } from './parseCdArgs.js'

export const call: LocalCommandCall = async args => {
  const target = parseCdArgs(args, getCwd())
  if (!target.ok) return { type: 'text', value: target.error }

  let isDir = false
  try {
    isDir = (await stat(target.path)).isDirectory()
  } catch {
    return { type: 'text', value: `/cd: "${target.path}" does not exist.` }
  }
  if (!isDir) {
    return { type: 'text', value: `/cd: "${target.path}" is not a directory.` }
  }
  // The new directory brings its own CLAUDE.md, hooks and settings: only enter
  // it when the user already trusted it (start fnharness there once otherwise).
  if (!isPathTrusted(target.path)) {
    return {
      type: 'text',
      value: `/cd: "${target.path}" is not trusted yet. Start fnharness there once to accept the trust dialog, then retry.`,
    }
  }

  // Keep appending to the same transcript: pin the session to the project
  // directory it started in before originalCwd (which derives it) changes.
  switchSession(
    getSessionId(),
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
  )

  process.chdir(target.path)
  setCwd(target.path)
  setOriginalCwd(getCwd())
  setProjectRoot(getCwd())

  // Everything keyed on the project directory must be recomputed.
  getProjectPathForConfig.cache.clear?.()
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
  resetSettingsCache()
  updateHooksConfigSnapshot()
  clearCommandsCache()

  return { type: 'text', value: `Now working in ${getCwd()}` }
}
