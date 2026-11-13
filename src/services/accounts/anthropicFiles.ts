/**
 * Files of a Claude (Anthropic OAuth) account: `<config>/accounts/<id>/`.
 *
 *   credentials.json      OAuth tokens (same shape as the root .credentials.json), 0600
 *   oauth-account.json    who the account is: email, organisation, plan (AccountInfo), 0600
 *   remote-settings.json  remote managed settings of its organisation, 0600
 *   policy-limits.json    policy limits of its organisation, 0600
 *
 * The account `claude` is "root-linked": its tokens keep living in the root
 * `<config>/.credentials.json` (and its identity in `.claude.json`), so older
 * builds and other sessions sharing the directory keep working; the files in
 * `accounts/claude/` are a copy kept in step by this build.
 *
 * This module is a leaf (fs, path, os only) so the settings pipeline can read
 * it without pulling auth.ts into its import cycle. Nothing here ever logs or
 * returns a token outside the value read: callers must not print it.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type Env = Record<string, string | undefined>

export const ROOT_LINKED_ACCOUNT_ID = 'claude'

export const ACCOUNT_FILES = {
  credentials: 'credentials.json',
  oauthAccount: 'oauth-account.json',
  remoteSettings: 'remote-settings.json',
  policyLimits: 'policy-limits.json',
} as const

export type AccountFile = keyof typeof ACCOUNT_FILES

/** Files in the root config dir that hold the same data for the legacy single account. */
export const ROOT_FILES = {
  credentials: '.credentials.json',
  remoteSettings: 'remote-settings.json',
  policyLimits: 'policy-limits.json',
  globalConfig: '.claude.json',
} as const

/** Pure: account ids are short, lowercase and safe as a directory name (no `..`, no `/`). */
export function isValidAccountId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) && !id.includes('..')
}

export function configHome(env: Env = process.env): string {
  return (env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).normalize('NFC')
}

export function accountsDir(env: Env = process.env): string {
  return join(configHome(env), 'accounts')
}

export function accountDir(id: string, env: Env = process.env): string {
  if (!isValidAccountId(id)) throw new Error(`id de cuenta no válido: "${id}"`)
  return join(accountsDir(env), id)
}

export function accountFilePath(id: string, file: AccountFile, env: Env = process.env): string {
  return join(accountDir(id, env), ACCOUNT_FILES[file])
}

export function rootFilePath(file: keyof typeof ROOT_FILES, env: Env = process.env): string {
  return join(configHome(env), ROOT_FILES[file])
}

/** JSON object at `path`, or null when it is missing, unreadable or not an object. */
export function readJsonObject<T = Record<string, unknown>>(path: string): T | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as T) : null
  } catch {
    return null
  }
}

export function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

/** Creates `<config>/accounts/<id>/` with mode 0700 (and `accounts/` too). */
export function ensureAccountDir(id: string, env: Env = process.env): string {
  const root = accountsDir(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = accountDir(id, env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}

/**
 * Writes `data` as JSON with mode 0600, atomically (temporary file in the same
 * directory, fsync, rename), so a reader never sees half a credentials file.
 */
export function writeJsonPrivate(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

export function writeAccountFile(id: string, file: AccountFile, data: unknown, env: Env = process.env): void {
  ensureAccountDir(id, env)
  writeJsonPrivate(accountFilePath(id, file, env), data)
}

export function readAccountFile<T = Record<string, unknown>>(id: string, file: AccountFile, env: Env = process.env): T | null {
  if (!isValidAccountId(id)) return null
  return readJsonObject<T>(accountFilePath(id, file, env))
}

export function accountFileExists(id: string, file: AccountFile, env: Env = process.env): boolean {
  return isValidAccountId(id) && existsSync(accountFilePath(id, file, env))
}
