import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'

export type CdTarget =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * Pure: turns the raw `/cd` argument into an absolute path. Accepts optional
 * surrounding quotes, `~` and `~/x` (home) and relative paths (against `cwd`).
 * Does not touch the file system.
 */
export function parseCdArgs(
  args: string | undefined,
  cwd: string,
  home: string = homedir(),
): CdTarget {
  let raw = (args ?? '').trim()
  if (raw === '') {
    return { ok: false, error: 'Usage: /cd <path>' }
  }
  if (
    raw.length >= 2 &&
    (raw[0] === '"' || raw[0] === "'") &&
    raw[raw.length - 1] === raw[0]
  ) {
    raw = raw.slice(1, -1).trim()
    if (raw === '') {
      return { ok: false, error: 'Usage: /cd <path>' }
    }
  }
  if (raw === '~') return { ok: true, path: resolve(home) }
  if (raw.startsWith('~/')) return { ok: true, path: resolve(home, raw.slice(2)) }
  return { ok: true, path: isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw) }
}
