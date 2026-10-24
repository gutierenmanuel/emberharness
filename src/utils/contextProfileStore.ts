/**
 * Persistence of the context profile, remembered per account:
 *  - multimodel accounts: `contextProfile` in accounts.json
 *  - the claude account: `contextProfile` in the global config (.claude.json)
 *
 * FNHARNESS_CONTEXT_PROFILE (a preset name or "mcp:x skill:y tools:z") forces
 * the profile at launch without touching what is saved.
 */

import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  isLocalUrl,
  loadStore,
  profileForAccount,
  saveStore,
} from '../services/api/openai-compat/accounts.js'
import { getMultimodelProfile } from '../services/api/openai-compat/profiles.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import type { AppState } from '../state/AppStateStore.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import {
  defaultProfileForAccount,
  parseStoredProfile,
  type ContextProfile,
} from './contextProfile.js'

type Env = Record<string, string | undefined>

export function currentAccountId(env: Env = process.env): string {
  return env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
}

function backendIsLocal(id: string, env: Env): boolean {
  if (id === currentAccountId(env)) return isLocalUrl(getMultimodelProfile()?.baseUrl ?? null)
  try {
    return isLocalUrl(profileForAccount(id, loadStore(accountsFilePath(env)), env)?.baseUrl ?? null)
  } catch {
    return false
  }
}

/** Saved profile of `id`, or its default (local backends -> Simple). */
export function loadContextProfileForAccount(id: string, env: Env = process.env): ContextProfile {
  let saved: unknown
  try {
    saved = id === CLAUDE_ACCOUNT_ID
      ? getGlobalConfig().contextProfile
      : loadStore(accountsFilePath(env)).accounts[id]?.contextProfile
  } catch {
    saved = undefined
  }
  return parseStoredProfile(saved) ?? defaultProfileForAccount(id, backendIsLocal(id, env))
}

/** Profile at launch: env override, then the active account's saved/default one. */
export function resolveInitialContextProfile(env: Env = process.env): ContextProfile {
  const forced = parseStoredProfile(env.FNHARNESS_CONTEXT_PROFILE)
  return forced ?? loadContextProfileForAccount(currentAccountId(env), env)
}

export function saveContextProfileForAccount(id: string, profile: ContextProfile, env: Env = process.env): void {
  try {
    if (id === CLAUDE_ACCOUNT_ID) {
      saveGlobalConfig(c => ({ ...c, contextProfile: { ...profile } }))
      return
    }
    const path = accountsFilePath(env)
    const store = loadStore(path)
    store.accounts[id] = { ...store.accounts[id], contextProfile: { ...profile } }
    saveStore(store, path)
  } catch {
    // Keep the in-session profile even if it cannot be persisted.
  }
}

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Makes `profile` the session's profile and remembers it for the active
 * account. The running turn keeps the tools it started with (they are
 * snapshotted when the turn begins); the change applies from the next one.
 */
export function applyContextProfile(
  setAppState: SetAppState,
  profile: ContextProfile,
  env: Env = process.env,
): void {
  setAppState(prev => ({ ...prev, contextProfile: profile }))
  // Cached prompt sections (tool guidance, skills) depend on the tool set.
  clearSystemPromptSections()
  saveContextProfileForAccount(currentAccountId(env), profile, env)
}
