import { isLocalBaseUrl } from './speedStats.js'

/**
 * Local accounts (a model served on this machine, small context window) start
 * with `--setting-sources user`: the project CLAUDE.md files, `.claude/rules`
 * and the project hooks are not loaded, which in a big repository is ~5k tokens
 * and a slow first answer. Returns the value to apply as if the user had typed
 * it, or undefined to leave the sources untouched.
 *
 * An explicit `--setting-sources` always wins; `FNHARNESS_LOCAL_LEAN=0`
 * (or false/off) turns the default off.
 */
export const LOCAL_LEAN_SETTING_SOURCES = 'user'

export function localLeanEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.FNHARNESS_LOCAL_LEAN?.toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off')
}

export function defaultLocalSettingSources(input: {
  baseUrl: string | undefined
  explicitFlag: string | undefined
  env?: Record<string, string | undefined>
}): string | undefined {
  if (input.explicitFlag !== undefined) return undefined
  if (!localLeanEnabled(input.env)) return undefined
  return isLocalBaseUrl(input.baseUrl) ? LOCAL_LEAN_SETTING_SOURCES : undefined
}
