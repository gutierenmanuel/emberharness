/**
 * Leaf state module for the remote-managed-settings sync cache.
 *
 * Split from syncCache.ts to break the settings.ts → syncCache.ts → auth.ts →
 * settings.ts cycle. auth.ts sits inside the large settings SCC; importing it
 * from settings.ts's own dependency chain pulls hundreds of modules into the
 * eagerly-evaluated SCC at startup.
 *
 * This module imports only leaves (path, envUtils, file, json, types,
 * settings/settingsCache — also a leaf, only type-imports validation). settings.ts
 * reads the cache from here. syncCache.ts keeps isRemoteManagedSettingsEligible
 * (the auth-touching part) and re-exports everything from here for callers that
 * don't care about the cycle.
 *
 * Eligibility is a tri-state here: undefined (not yet determined — return
 * null), false (ineligible — return null), true (proceed). managedEnv.ts
 * calls isRemoteManagedSettingsEligible() just before the policySettings
 * read — after userSettings/flagSettings env vars are applied, so the check
 * sees config-provided CLAUDE_CODE_USE_BEDROCK/ANTHROPIC_BASE_URL. That call
 * computes once and mirrors the result here via setEligibility(). Every
 * subsequent read hits the cached bool instead of re-running the auth chain.
 */

import { join } from 'path'
import {
  ROOT_LINKED_ACCOUNT_ID,
  accountDir,
  accountFilePath,
  writeJsonPrivate,
} from '../accounts/anthropicFiles.js'
import { mergeManagedSettings } from '../accounts/managedPolicy.js'
import {
  accountsInForce,
  activeAnthropicAccountId,
  onAccountTouched,
} from '../accounts/sessionAccounts.js'
import { existsSync } from 'fs'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { readFileSync } from '../../utils/fileRead.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { jsonParse } from '../../utils/slowOperations.js'

const SETTINGS_FILENAME = 'remote-settings.json'

// Several Claude accounts (services/accounts): each one has its own remote
// settings (`claude` in the root file, the others in accounts/<id>/). The
// raw settings of each account are cached here; the session sees the merge
// of every in-force account (D7), without telemetry (that belongs to the
// account, not to process.env).
const rawCache = new Map<string, SettingsJson | null>()
const eligibleByAccount = new Map<string, boolean>()
let mergedCache: SettingsJson | null | undefined

function invalidateMerged(): void {
  mergedCache = undefined
}

// A Claude account joining (or leaving) the session changes the merged view.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
onAccountTouched(() => {
  invalidateMerged()
  resetSettingsCache()
})

/** Raw settings just fetched (or confirmed) for the active Claude account. */
export function setSessionCache(value: SettingsJson | null): void {
  rawCache.set(activeAnthropicAccountId(), value)
  invalidateMerged()
}

export function resetSyncCache(): void {
  rawCache.clear()
  eligibleByAccount.clear()
  invalidateMerged()
}

/** Eligibility of the active Claude account (computed in syncCache.ts). */
export function setEligibility(v: boolean): boolean {
  eligibleByAccount.set(activeAnthropicAccountId(), v)
  invalidateMerged()
  return v
}

/** remote-settings.json of a Claude account (default: the active one). */
export function getSettingsPath(accountId: string = activeAnthropicAccountId()): string {
  return accountId === ROOT_LINKED_ACCOUNT_ID
    ? join(getClaudeConfigHomeDir(), SETTINGS_FILENAME)
    : accountFilePath(accountId, 'remoteSettings')
}

/** `claude` was migrated: keep accounts/claude/remote-settings.json a copy of the root file. */
export function mirrorRootRemoteSettings(settings: SettingsJson | null): void {
  try {
    if (!existsSync(accountDir(ROOT_LINKED_ACCOUNT_ID))) return
    if (settings) writeJsonPrivate(accountFilePath(ROOT_LINKED_ACCOUNT_ID, 'remoteSettings'), settings)
  } catch {
    // A copy only; the root file is the truth for `claude`.
  }
}

// sync IO — settings pipeline is sync. fileRead and jsonRead are leaves;
// file.ts and json.ts both sit in the settings SCC.
function loadSettings(accountId: string): SettingsJson | null {
  try {
    const content = readFileSync(getSettingsPath(accountId))
    const data: unknown = jsonParse(stripBOM(content))
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    return data as SettingsJson
  } catch {
    return null
  }
}

/**
 * Raw remote settings of one Claude account (telemetry included), or null.
 * `claude` keeps the legacy guard (nothing until its eligibility is known to
 * be true); another account applies its cached file unless it was found
 * ineligible, since that file is only written when it was eligible.
 */
export function getAccountRemoteSettings(accountId: string = activeAnthropicAccountId()): SettingsJson | null {
  const eligible = eligibleByAccount.get(accountId)
  if (accountId === ROOT_LINKED_ACCOUNT_ID ? eligible !== true : eligible === false) return null
  const cached = rawCache.get(accountId)
  if (cached) return cached
  const fromFile = loadSettings(accountId)
  if (fromFile) rawCache.set(accountId, fromFile)
  return fromFile
}

/**
 * The managed settings the session runs with: those of every in-force Claude
 * account (the session's and each one that served a request), combined
 * keeping the most restrictive values, with the telemetry part removed.
 */
export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (mergedCache !== undefined) return mergedCache
  const merged = mergeManagedSettings(
    accountsInForce().map(accountId => ({
      accountId,
      settings: getAccountRemoteSettings(accountId) as Record<string, unknown> | null,
    })),
  ).settings as SettingsJson | null
  mergedCache = merged
  if (merged) {
    // Remote settings just became available (or changed): any merged
    // getSettings_DEPRECATED() result cached before this moment misses this
    // policySettings layer. Flush so the next read re-merges with it (see the
    // gh-23085 note in the upstream history of this file).
    resetSettingsCache()
  }
  return merged
}
