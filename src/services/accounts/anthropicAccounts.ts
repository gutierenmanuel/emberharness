/**
 * Several Claude (Anthropic OAuth) accounts in one harness.
 *
 * `claude` is the legacy account: root-linked, its tokens stay in the root
 * `.credentials.json` and its identity in `.claude.json`, exactly as before.
 * Any other account (`kind: "anthropic"` in accounts.json) keeps everything in
 * `<config>/accounts/<id>/` (see anthropicFiles.ts).
 *
 * auth.ts stays a thin dispatcher: it asks tokenAccountId() and, when it is
 * not null, reads and writes the tokens and identity of that account here.
 *
 * Security: tokens are only ever read from and written to the account's own
 * files (0600, atomic writes). Nothing here logs a token, a header or a key;
 * messages only say whether there is a token.
 */

import { existsSync, readdirSync, rmSync, statSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  anthropicAccountIds,
  isAnthropicAccount,
  loadStore,
  saveStore,
  type AccountStore,
} from '../api/openai-compat/accounts.js'
import { getProviderPresets } from '../config/providers.js'
import { getScopedAccountId, MultimodelConfigError } from '../api/openai-compat/profiles.js'
import {
  ROOT_LINKED_ACCOUNT_ID,
  accountDir,
  accountFileExists,
  accountFilePath,
  accountsDir,
  configHome,
  ensureAccountDir,
  fileMtimeMs,
  isValidAccountId,
  readAccountFile,
  readJsonObject,
  rootFilePath,
  writeAccountFile,
  writeJsonPrivate,
} from './anthropicFiles.js'
import { activeAnthropicAccountId, readStoreView, setScopedAccountResolver } from './sessionAccounts.js'

type Env = Record<string, string | undefined>

// The request scope (profiles.ts) tells the leaf which account a routed request runs on.
setScopedAccountResolver(getScopedAccountId)

/** Same shape as OAuthTokens (services/oauth/types), kept structural to stay a light import. */
export type StoredOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
}

/** Same shape as AccountInfo (utils/config). */
export type StoredAccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null
  organizationRole?: string | null
  workspaceRole?: string | null
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: string | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

export function isRootLinked(id: string): boolean {
  return id === ROOT_LINKED_ACCOUNT_ID
}

/**
 * The account whose own files hold the tokens to use right now, or null when
 * the legacy root files apply (the `claude` account, or a token forced through
 * CLAUDE_CODE_OAUTH_TOKEN / a file descriptor).
 */
export function tokenAccountId(env: Env = process.env): string | null {
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) return null
  const id = activeAnthropicAccountId(env)
  return isRootLinked(id) ? null : id
}

/** API base URL configured for the active Claude account (a proxy or a test server), if any. */
export function anthropicAccountBaseUrl(env: Env = process.env): string | undefined {
  const id = activeAnthropicAccountId(env)
  const url = readStoreView(env).accounts[id]?.baseUrl
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : undefined
}

// ── tokens ──────────────────────────────────────────────────────────────

type TokenCache = { mtimeMs: number; srcMtimeMs: number; tokens: StoredOAuthTokens | null }
const tokenCache = new Map<string, TokenCache>()

export function clearAccountTokenCache(id?: string): void {
  if (id) tokenCache.delete(id)
  else tokenCache.clear()
}

function oauthOf(data: Record<string, unknown> | null): StoredOAuthTokens | null {
  const o = data?.claudeAiOauth as StoredOAuthTokens | undefined
  return o && typeof o.accessToken === 'string' && o.accessToken ? o : null
}

/** Pure: `candidate` is a newer login than `current` (later expiry, other token). */
export function isFresherToken(candidate: StoredOAuthTokens | null, current: StoredOAuthTokens | null): boolean {
  if (!candidate?.accessToken || !candidate.refreshToken) return false
  if (!current) return true
  if (candidate.accessToken === current.accessToken) return false
  return (candidate.expiresAt ?? 0) > (current.expiresAt ?? 0)
}

function importedCredentialsPath(id: string, env: Env): string | null {
  const from = readStoreView(env).accounts[id]?.importedFrom
  return typeof from === 'string' && from ? join(from, '.credentials.json') : null
}

/**
 * OAuth tokens of a non-root account. When the account was imported from
 * another config dir and that dir holds a newer login (its own harness
 * refreshed first), the newer tokens are adopted into this account's file;
 * the source dir is only read, never written.
 */
export function readAccountTokens(id: string, env: Env = process.env): StoredOAuthTokens | null {
  if (!isValidAccountId(id)) return null
  const path = accountFilePath(id, 'credentials', env)
  const src = importedCredentialsPath(id, env)
  const mtimeMs = fileMtimeMs(path)
  const srcMtimeMs = src ? fileMtimeMs(src) : -1
  const hit = tokenCache.get(id)
  if (hit && hit.mtimeMs === mtimeMs && hit.srcMtimeMs === srcMtimeMs) return hit.tokens
  let tokens = oauthOf(readJsonObject(path))
  if (src && srcMtimeMs > 0) {
    const theirs = oauthOf(readJsonObject(src))
    if (isFresherToken(theirs, tokens)) {
      writeAccountFile(id, 'credentials', { claudeAiOauth: theirs }, env)
      tokens = theirs
    }
  }
  tokenCache.set(id, { mtimeMs: fileMtimeMs(path), srcMtimeMs, tokens })
  return tokens
}

/** Saves tokens for a non-root account, keeping a known plan when the new tokens lack it. */
export function writeAccountTokens(id: string, tokens: StoredOAuthTokens, env: Env = process.env): void {
  const prev = oauthOf(readAccountFile(id, 'credentials', env))
  writeAccountFile(
    id,
    'credentials',
    {
      claudeAiOauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        subscriptionType: tokens.subscriptionType ?? prev?.subscriptionType ?? null,
        rateLimitTier: tokens.rateLimitTier ?? prev?.rateLimitTier ?? null,
      },
    },
    env,
  )
  clearAccountTokenCache(id)
}

/**
 * Keeps `accounts/claude/credentials.json` a copy of the root credentials
 * after this build saves them (only when the account was migrated).
 */
export function mirrorRootCredentials(data: unknown, env: Env = process.env): void {
  try {
    if (!existsSync(accountDir(ROOT_LINKED_ACCOUNT_ID, env))) return
    writeJsonPrivate(accountFilePath(ROOT_LINKED_ACCOUNT_ID, 'credentials', env), data)
  } catch {
    // The copy is a convenience; the root file is the truth for `claude`.
  }
}

/** Directory whose lock serialises token refreshes of the active account. */
export function refreshLockDir(env: Env = process.env): string | null {
  const id = tokenAccountId(env)
  return id ? ensureAccountDir(id, env) : null
}

/** File whose mtime tells another process refreshed the active account's tokens. */
export function activeCredentialsPath(env: Env = process.env): string {
  const id = tokenAccountId(env)
  return id ? accountFilePath(id, 'credentials', env) : rootFilePath('credentials', env)
}

// ── identity ────────────────────────────────────────────────────────────

const infoCache = new Map<string, { mtimeMs: number; info: StoredAccountInfo | null }>()

export function readAccountInfo(id: string, env: Env = process.env): StoredAccountInfo | null {
  if (!isValidAccountId(id)) return null
  const path = accountFilePath(id, 'oauthAccount', env)
  const mtimeMs = fileMtimeMs(path)
  const hit = infoCache.get(id)
  if (hit && hit.mtimeMs === mtimeMs) return hit.info
  const info = readJsonObject<StoredAccountInfo>(path)
  infoCache.set(id, { mtimeMs, info })
  return info
}

export function writeAccountInfo(id: string, info: StoredAccountInfo, env: Env = process.env): void {
  writeAccountFile(id, 'oauthAccount', info, env)
  infoCache.delete(id)
}

export function updateAccountInfo(id: string, updates: Partial<StoredAccountInfo>, env: Env = process.env): void {
  const prev = readAccountInfo(id, env)
  if (!prev) return
  writeAccountInfo(id, { ...prev, ...updates }, env)
}

// ── login target (/account add claude <id>) ─────────────────────────────

let loginTarget: string | null = null

/** While set, a completed OAuth login is written to `accounts/<id>/` instead of the root. */
export function setLoginTargetAccount(id: string | null): void {
  loginTarget = id
}

export function getLoginTargetAccount(): string | null {
  return loginTarget
}

/** Registers `id` as a Claude account in accounts.json (keeps what it already had). */
export function registerAnthropicAccount(id: string, extra: { importedFrom?: string; label?: string } = {}, env: Env = process.env): void {
  const path = accountsFilePath(env)
  const store = loadStore(path)
  const prev = store.accounts[id] ?? {}
  store.accounts[id] = {
    ...prev,
    kind: 'anthropic',
    label: extra.label ?? prev.label ?? 'Claude (Anthropic)',
    ...(extra.importedFrom ? { importedFrom: extra.importedFrom } : {}),
  }
  saveStore(store, path)
}

/** Checks `id` can name a new Claude account (`claude` itself is allowed when not yet registered). */
export function assertNewAccountId(id: string, store: AccountStore, opts: { allowClaude?: boolean } = {}): void {
  if (!isValidAccountId(id)) {
    throw new MultimodelConfigError(`"${id}" no vale como id de cuenta: minúsculas, dígitos, «.», «_» o «-» (máx. 64).`)
  }
  if (id === CLAUDE_ACCOUNT_ID && !opts.allowClaude) {
    throw new MultimodelConfigError('"claude" es la cuenta Claude de siempre (/login); elige otro id, p. ej. claude-trabajo.')
  }
  if (id in getProviderPresets()) throw new MultimodelConfigError(`"${id}" es una cuenta integrada; elige otro id.`)
  const prev = store.accounts[id]
  if (prev && !(opts.allowClaude && id === CLAUDE_ACCOUNT_ID)) {
    throw new MultimodelConfigError(
      isAnthropicAccount(id, store)
        ? `Ya existe la cuenta Claude "${id}". Para rehacerla: /logout ${id} y vuelve a añadirla.`
        : `Ya existe una cuenta "${id}" (OpenAI-compatible). Elige otro id.`,
    )
  }
}

/** Writes a fresh OAuth login into `accounts/<id>/` and registers the account. */
export function installTokensForAccount(
  id: string,
  tokens: StoredOAuthTokens,
  info: StoredAccountInfo | null,
  env: Env = process.env,
): void {
  if (!tokens.refreshToken || !tokens.scopes?.includes('user:inference')) {
    throw new Error('Ese login no es de una suscripción de Claude (claude.ai): no se guarda como cuenta Claude.')
  }
  ensureAccountDir(id, env)
  if (info) writeAccountInfo(id, info, env)
  writeAccountTokens(id, tokens, env)
  registerAnthropicAccount(id, {}, env)
}

// ── migration and import ────────────────────────────────────────────────

export type MigrationResult = { migrated: boolean; reason: 'no-root-credentials' | 'already' | 'migrated'; copied: string[] }

function copyJsonIfAbsent(src: string, id: string, file: 'credentials' | 'remoteSettings' | 'policyLimits', env: Env, copied: string[]): void {
  if (accountFileExists(id, file, env)) return
  const data = readJsonObject(src)
  if (!data) return
  writeAccountFile(id, file, data, env)
  copied.push(file)
}

function oauthAccountFrom(globalConfigPath: string): StoredAccountInfo | null {
  const cfg = readJsonObject<{ oauthAccount?: StoredAccountInfo }>(globalConfigPath)
  const info = cfg?.oauthAccount
  return info && typeof info.emailAddress === 'string' ? info : null
}

/**
 * One-time, idempotent and lossless: when the root holds `.credentials.json`
 * and no Claude account is registered yet, registers `claude` and COPIES its
 * credentials, identity, remote settings and policy limits into
 * `accounts/claude/`. Nothing in the root is moved or deleted, and `claude`
 * keeps reading the root files.
 */
export function migrateRootClaudeAccount(env: Env = process.env): MigrationResult {
  const copied: string[] = []
  if (!existsSync(rootFilePath('credentials', env))) return { migrated: false, reason: 'no-root-credentials', copied }
  const store = loadStore(accountsFilePath(env))
  const registered = Object.keys(store.accounts).some(id => store.accounts[id]?.kind === 'anthropic')
  if (registered) return { migrated: false, reason: 'already', copied }
  ensureAccountDir(ROOT_LINKED_ACCOUNT_ID, env)
  copyJsonIfAbsent(rootFilePath('credentials', env), ROOT_LINKED_ACCOUNT_ID, 'credentials', env, copied)
  copyJsonIfAbsent(rootFilePath('remoteSettings', env), ROOT_LINKED_ACCOUNT_ID, 'remoteSettings', env, copied)
  copyJsonIfAbsent(rootFilePath('policyLimits', env), ROOT_LINKED_ACCOUNT_ID, 'policyLimits', env, copied)
  const info = oauthAccountFrom(rootFilePath('globalConfig', env))
  if (info && !accountFileExists(ROOT_LINKED_ACCOUNT_ID, 'oauthAccount', env)) {
    writeAccountInfo(ROOT_LINKED_ACCOUNT_ID, info, env)
    copied.push('oauthAccount')
  }
  registerAnthropicAccount(ROOT_LINKED_ACCOUNT_ID, {}, env)
  return { migrated: true, reason: 'migrated', copied }
}

/** `~/x` and relative paths to an absolute path. */
export function expandDir(dir: string): string {
  const d = dir.trim()
  return resolve(d === '~' ? homedir() : d.startsWith('~/') ? join(homedir(), d.slice(2)) : d)
}

export type ImportResult = { id: string; email: string | null; org: string | null; copied: string[] }

/**
 * `/account import <dir> --as <id>`: copies the Claude login of another config
 * dir (e.g. ~/.fnharness-work) into `accounts/<id>/`. The source dir is only
 * read; it keeps working with its own launcher.
 */
export function importAnthropicAccount(dir: string, id: string, env: Env = process.env): ImportResult {
  const src = expandDir(dir)
  if (src === resolve(configHome(env))) throw new MultimodelConfigError('Ese directorio es el de esta misma configuración: su cuenta ya es «claude».')
  const store = loadStore(accountsFilePath(env))
  assertNewAccountId(id, store)
  const creds = readJsonObject(join(src, '.credentials.json'))
  const tokens = oauthOf(creds)
  if (!tokens) throw new MultimodelConfigError(`No hay credenciales OAuth de Claude en ${src} (falta .credentials.json con login).`)
  const copied: string[] = []
  ensureAccountDir(id, env)
  writeAccountFile(id, 'credentials', { claudeAiOauth: tokens }, env)
  copied.push('credentials')
  copyJsonIfAbsent(join(src, 'remote-settings.json'), id, 'remoteSettings', env, copied)
  copyJsonIfAbsent(join(src, 'policy-limits.json'), id, 'policyLimits', env, copied)
  const info = oauthAccountFrom(join(src, '.claude.json'))
  if (info) {
    writeAccountInfo(id, info, env)
    copied.push('oauthAccount')
  }
  registerAnthropicAccount(id, { importedFrom: src }, env)
  clearAccountTokenCache(id)
  return { id, email: info?.emailAddress ?? null, org: info?.organizationName ?? null, copied }
}

/**
 * `/logout <id>`: deletes only `accounts/<id>/` and its entry in
 * accounts.json. `claude` keeps the plain /logout (root files), and the
 * session's own account must be switched away from first.
 */
export function logoutAnthropicAccount(id: string, env: Env = process.env): void {
  const path = accountsFilePath(env)
  const store = loadStore(path)
  if (id === CLAUDE_ACCOUNT_ID) throw new MultimodelConfigError('La cuenta «claude» se cierra con /logout sin argumentos (borra las credenciales de la raíz).')
  if (!isAnthropicAccount(id, store)) throw new MultimodelConfigError(`"${id}" no es una cuenta Claude de este arnés (mira /account list).`)
  if ((env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID) === id) {
    throw new MultimodelConfigError(`"${id}" es la cuenta de esta sesión: cambia antes a otra (/account <id>) y repite /logout ${id}.`)
  }
  const dir = accountDir(id, env)
  const root = resolve(accountsDir(env)) + sep
  if (!resolve(dir).startsWith(root)) throw new Error('ruta de cuenta fuera de accounts/')
  rmSync(dir, { recursive: true, force: true })
  delete store.accounts[id]
  if (store.active === id) store.active = CLAUDE_ACCOUNT_ID
  if (store.default === id) delete store.default
  saveStore(store, path)
  clearAccountTokenCache(id)
  infoCache.delete(id)
}

// ── status and permissions ──────────────────────────────────────────────

export type AnthropicAccountStatus = {
  id: string
  hasToken: boolean
  expired: boolean
  plan: string | null
  email: string | null
  org: string | null
  orgUuid: string | null
  importedFrom: string | null
}

/**
 * What /account shows about a Claude account. `rootInfo` / `rootTokens` are
 * the legacy identity and tokens, passed in for `claude` (they live in
 * .claude.json and the secure storage, read by the caller).
 */
export function anthropicAccountStatus(
  id: string,
  root: { info?: StoredAccountInfo | null; tokens?: StoredOAuthTokens | null } = {},
  env: Env = process.env,
  now = Date.now(),
): AnthropicAccountStatus {
  const tokens = isRootLinked(id) ? (root.tokens ?? null) : readAccountTokens(id, env)
  const info = isRootLinked(id) ? (root.info ?? readAccountInfo(id, env)) : readAccountInfo(id, env)
  const from = readStoreView(env).accounts[id]?.importedFrom
  return {
    id,
    hasToken: !!tokens?.accessToken,
    expired: !!tokens?.expiresAt && tokens.expiresAt < now && !tokens.refreshToken,
    plan: tokens?.subscriptionType ?? null,
    email: info?.emailAddress ?? null,
    org: info?.organizationName ?? null,
    orgUuid: info?.organizationUuid ?? null,
    importedFrom: typeof from === 'string' ? from : null,
  }
}

export type PermissionFinding = { path: string; kind: 'dir' | 'file'; mode: number; want: number; ok: boolean }

/** Pure: a finding for one path; group/other bits must be off (0700 dirs, 0600 files). */
export function permissionFinding(path: string, kind: 'dir' | 'file', mode: number): PermissionFinding {
  const want = kind === 'dir' ? 0o700 : 0o600
  return { path, kind, mode: mode & 0o777, want, ok: (mode & 0o077) === 0 }
}

/** Every credential-bearing path of this config dir and whether its mode is private. */
export function auditAccountPermissions(env: Env = process.env): PermissionFinding[] {
  const out: PermissionFinding[] = []
  const check = (path: string, kind: 'dir' | 'file') => {
    try {
      out.push(permissionFinding(path, kind, statSync(path).mode))
    } catch {
      // Missing: nothing to protect.
    }
  }
  check(rootFilePath('credentials', env), 'file')
  check(accountsFilePath(env), 'file')
  const root = accountsDir(env)
  if (!existsSync(root)) return out
  check(root, 'dir')
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    check(dir, 'dir')
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) check(join(dir, f), 'file')
    }
  }
  return out
}

/** chmods every finding that is not private; returns the paths fixed. */
export function fixAccountPermissions(findings: PermissionFinding[]): string[] {
  const fixed: string[] = []
  for (const f of findings) {
    if (f.ok) continue
    chmodSync(f.path, f.want)
    fixed.push(f.path)
  }
  return fixed
}

export { anthropicAccountIds }
