/**
 * Accounts: named, switchable backends (claude, llamacpp, openai, ...).
 *
 * An account is either the native Anthropic path ("claude") or an
 * OpenAI-compatible backend built from a provider preset plus optional
 * per-account overrides (key, model, base URL) persisted in
 * `<config dir>/accounts.json` with mode 0600.
 *
 * Everything that touches the filesystem takes its paths/env as parameters so
 * the pure parts stay testable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  MultimodelConfigError,
  PROVIDER_PRESETS,
  resolveProfile,
  type MultimodelProfile,
} from './profiles.js'

export const CLAUDE_ACCOUNT_ID = 'claude'

export type StoredAccount = {
  provider?: string
  label?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  smallModel?: string
}

export type AccountStore = {
  active?: string
  accounts: Record<string, StoredAccount>
}

export type Account = {
  id: string
  label: string
  /** null for the native Anthropic account. */
  provider: string | null
  baseUrl: string | null
  /** Whether the account can be used right now without more setup. */
  ready: boolean
  /** Why it is not ready, or a short hint when it is. */
  detail: string
}

type Env = Record<string, string | undefined>

export function accountsFilePath(env: Env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'accounts.json')
}

export function loadStore(path = accountsFilePath()): AccountStore {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { active: raw.active, accounts: raw.accounts ?? {} }
  } catch {
    return { accounts: {} }
  }
}

export function saveStore(store: AccountStore, path = accountsFilePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  // writeFileSync only applies the mode on creation.
  chmodSync(path, 0o600)
}

/** The env the profile resolver should see for one account. */
export function accountEnv(
  id: string,
  store: AccountStore,
  base: Env,
): Env {
  const stored = store.accounts[id] ?? {}
  const provider = stored.provider ?? id
  return {
    ...base,
    CLAUDE_MULTIMODEL_PROVIDER: provider,
    CLAUDE_MULTIMODEL_BASE_URL: stored.baseUrl,
    CLAUDE_MULTIMODEL_API_KEY: stored.apiKey,
    CLAUDE_MULTIMODEL_MODEL: stored.model,
    CLAUDE_MULTIMODEL_SMALL_MODEL: stored.smallModel ?? stored.model,
  }
}

/** Resolves an account to a backend profile; null means native Anthropic. */
export function profileForAccount(
  id: string,
  store: AccountStore,
  base: Env,
): MultimodelProfile | null {
  if (id === CLAUDE_ACCOUNT_ID) return null
  const known = id in PROVIDER_PRESETS || id in store.accounts
  if (!known) {
    throw new MultimodelConfigError(
      `Unknown account "${id}". Use /account list to see the available ones.`,
    )
  }
  return resolveProfile(accountEnv(id, store, base))
}

export function listAccounts(store: AccountStore, base: Env): Account[] {
  const ids = [
    CLAUDE_ACCOUNT_ID,
    ...Object.keys(PROVIDER_PRESETS).filter(id => id !== 'custom'),
    ...Object.keys(store.accounts).filter(
      id => id !== CLAUDE_ACCOUNT_ID && !(id in PROVIDER_PRESETS),
    ),
  ]
  return ids.map(id => describeAccount(id, store, base))
}

function describeAccount(id: string, store: AccountStore, base: Env): Account {
  if (id === CLAUDE_ACCOUNT_ID) {
    return {
      id,
      label: 'Claude (Anthropic)',
      provider: null,
      baseUrl: null,
      ready: true,
      detail: 'cuenta nativa; usa /login dentro de fnharness',
    }
  }
  const stored = store.accounts[id]
  try {
    const profile = profileForAccount(id, store, base)!
    return {
      id,
      label: stored?.label ?? profile.label,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      ready: true,
      detail: `${profile.model} @ ${profile.baseUrl}`,
    }
  } catch (err) {
    const preset = PROVIDER_PRESETS[stored?.provider ?? id]
    return {
      id,
      label: stored?.label ?? preset?.label ?? id,
      provider: stored?.provider ?? id,
      baseUrl: stored?.baseUrl ?? preset?.baseUrl ?? null,
      ready: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Probes a local server's model list so the picker can show what is up. */
export async function probeBackend(
  baseUrl: string,
  timeoutMs = 800,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

export function isLocalUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** Account id chosen at launch: explicit env first, then the persisted one. */
export function startupAccountId(store: AccountStore, env: Env): string {
  return env.CLAUDE_MULTIMODEL_ACCOUNT || store.active || CLAUDE_ACCOUNT_ID
}

export function storeExists(path = accountsFilePath()): boolean {
  return existsSync(path)
}
