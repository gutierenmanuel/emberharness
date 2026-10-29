/**
 * Config JSON with hot reload.
 *
 * `createHotJson` owns one user file in the config dir (`providers.json`,
 * `claude-models.json`, ...) layered over defaults versioned in the repo. Each
 * `get()` is cheap: at most once per `minIntervalMs` it stats the file, and only
 * when mtime or size changed does it read, parse and merge again. A file that
 * disappears falls back to the defaults; a file that is unreadable or invalid
 * keeps the last good value and reports the problem once. No fs.watch: editors
 * that replace the file by rename would break it, and a stat per second is free.
 *
 * Only `fs`, `os` and `path` are imported so the pure parts stay testable
 * without booting the harness.
 */

import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type Env = Record<string, string | undefined>

export type HotJsonOptions<T> = {
  /** File name inside the config dir. */
  file: string
  /** Value used when the user file is missing; also the base `merge` layers over. */
  defaults: T
  /** Pure: layers the parsed user JSON over the defaults. May throw on a bad shape. */
  merge: (defaults: T, user: unknown) => T
  /** Where it is reported when the user file is invalid (once per file version). */
  onError?: (message: string) => void
  /** Minimum time between two stat calls. */
  minIntervalMs?: number
  env?: Env
  now?: () => number
}

export type HotJson<T> = {
  /** Current value, reloading it first when the file changed. Never throws. */
  get(): T
  /** Forgets the cache so the next `get()` re-reads the file (tests, explicit reloads). */
  reset(): void
  /** Path of the user file in force. */
  path(): string
}

/** Config dir: `CLAUDE_CONFIG_DIR`, else `~/.claude` (same rule as accounts.json). */
export function configFilePath(file: string, env: Env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), file)
}

function signature(path: string): string | null {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

export function createHotJson<T>(opts: HotJsonOptions<T>): HotJson<T> {
  const minInterval = opts.minIntervalMs ?? 1000
  const now = opts.now ?? (() => Date.now())
  const envOf = () => opts.env ?? process.env
  let current: T = opts.defaults
  let lastPath: string | undefined
  let lastSig: string | null | undefined
  let lastCheck = -Infinity

  const path = () => configFilePath(opts.file, envOf())

  function load(p: string, sig: string | null): void {
    lastPath = p
    lastSig = sig
    if (sig === null) {
      current = opts.defaults
      return
    }
    try {
      current = opts.merge(opts.defaults, JSON.parse(readFileSync(p, 'utf8')))
    } catch (err) {
      // Keep the last good value; the signature is already recorded, so this
      // reports once per file version instead of on every call.
      opts.onError?.(`${p}: ${err instanceof Error ? err.message : String(err)}; se mantiene la configuración anterior`)
    }
  }

  return {
    get() {
      const t = now()
      const p = path()
      if (p === lastPath && t - lastCheck < minInterval) return current
      lastCheck = t
      const sig = signature(p)
      if (p !== lastPath || sig !== lastSig) load(p, sig)
      return current
    },
    reset() {
      lastPath = undefined
      lastSig = undefined
      lastCheck = -Infinity
      current = opts.defaults
    },
    path,
  }
}

/** Pure: plain object check used by the merge functions. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Pure: finite number or undefined. */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Pure: non-empty string or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
