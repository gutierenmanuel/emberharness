/**
 * Per-request account routing: a model written as `cuenta:modelo`
 * (`qwen36:qwen36-35b-heretic-q4km`, `claude:haiku`,
 * `openrouter:deepseek/deepseek-chat`) is served by THAT account for that
 * request only, while the session stays on its own account. Without a prefix
 * nothing changes.
 *
 * The prefix is recognised with the same rule as the fallback chain
 * (fallbackChain.ts): it counts as an account only when it is `claude`, a
 * built-in preset or a stored account, so `qwen3:8b` keeps being a model id.
 *
 * Mechanism: the request runs inside a ProfileScope (profiles.ts), so
 * getMultimodelProfile()/isMultimodelActive() answer for the routed account.
 * That is what makes `claude:` take the native path (OAuth, betas, auth
 * gating) inside a multimodel session, and an OpenAI-compatible account take
 * the adapter inside a Claude session, without touching process.env.
 *
 * The pure helpers come first and are unit-tested.
 */

import { statSync } from 'fs'
import { getModelStrings } from '../../utils/model/modelStrings.js'
import { claudeAliasApiId } from '../config/claudeModels.js'
import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  loadStore,
  profileForAccount,
  type AccountStore,
} from './openai-compat/accounts.js'
import { accountPredicate, parseFallbackTarget } from './fallbackChain.js'
import {
  getMultimodelProfile,
  getOriginalModelEnv,
  getScopedAccountId,
  runInProfileScope,
  scopeGenerator,
  type MultimodelProfile,
  type ProfileScope,
} from './openai-compat/profiles.js'

type Env = Record<string, string | undefined>

export type ClaudeDefaults = { opus: string; sonnet: string; haiku: string }

export type ModelRoute = {
  accountId: string
  /** null = native Anthropic account. */
  profile: MultimodelProfile | null
  /** Model id to send, prefix removed and aliases resolved. */
  model: string
  /** The routed account is the one already in force (no scope needed). */
  current: boolean
}

// ── pure ────────────────────────────────────────────────────────────────

/**
 * Pure: `cuenta:modelo` to its parts, or null when the string has no account
 * prefix. An empty model (`qwen36:`) means the account's own model.
 */
export function splitAccountModel(
  model: string,
  isAccount: (id: string) => boolean,
): { account: string; model: string } | null {
  const raw = model.trim()
  if (raw.indexOf(':') <= 0) return null
  const t = parseFallbackTarget(raw, isAccount)
  if (!t.account) return null
  return { account: t.account, model: t.model ?? '' }
}

/**
 * Pure: a Claude alias (`haiku`, `sonnet[1m]`, `opus`, `best`, `opusplan`,
 * empty = default) to a model id, reading the env model slots as they were
 * before a multimodel account rewrote them. Full ids pass through.
 */
export function resolveClaudeAlias(
  input: string,
  slots: Env,
  defaults: ClaudeDefaults,
): string {
  const trimmed = input.trim()
  const lower = trimmed.toLowerCase()
  const has1m = /\[1m\]$/.test(lower)
  const base = lower.replace(/\[1m\]$/, '').trim()
  const sfx = has1m ? '[1m]' : ''
  switch (base) {
    case '':
    case 'default': {
      const configured = slots.ANTHROPIC_MODEL?.trim()
      if (configured && !/^default$/i.test(configured)) {
        return resolveClaudeAlias(configured, { ...slots, ANTHROPIC_MODEL: undefined }, defaults)
      }
      return defaults.sonnet
    }
    case 'sonnet':
    case 'opusplan':
      return (slots.ANTHROPIC_DEFAULT_SONNET_MODEL || defaults.sonnet) + sfx
    case 'opus':
      return (slots.ANTHROPIC_DEFAULT_OPUS_MODEL || defaults.opus) + sfx
    case 'best':
      return slots.ANTHROPIC_DEFAULT_OPUS_MODEL || defaults.opus
    case 'haiku':
      return (slots.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaults.haiku) + sfx
    default:
      return trimmed
  }
}

export type RouteDeps = {
  env?: Env
  store?: AccountStore
  /** Account in force (request scope, else the session's). */
  currentAccount?: string
  /** Profile in force when currentAccount is not claude. */
  currentProfile?: MultimodelProfile | null
  claudeDefaults?: ClaudeDefaults
  originalSlots?: Env
}

/**
 * The route for `model`, or null when it has no account prefix. Throws
 * MultimodelConfigError when the account exists but cannot serve (missing
 * key, bad URL), so the request fails with one clear message.
 */
export function routeForModel(
  model: string | undefined | null,
  deps: RouteDeps = {},
): ModelRoute | null {
  if (!model || model.indexOf(':') <= 0) return null
  const env = deps.env ?? process.env
  const store = deps.store ?? cachedStore(env)
  const split = splitAccountModel(model, accountPredicate(store))
  if (!split) return null
  const current = deps.currentAccount ?? currentAccountId(env)
  if (split.account === CLAUDE_ACCOUNT_ID) {
    return {
      accountId: CLAUDE_ACCOUNT_ID,
      profile: null,
      model: resolveClaudeAlias(
        split.model,
        deps.originalSlots ?? getOriginalModelEnv(env),
        deps.claudeDefaults ?? claudeDefaults(),
      ),
      current: current === CLAUDE_ACCOUNT_ID,
    }
  }
  const isCurrent = split.account === current
  const inForce = isCurrent
    ? deps.currentProfile !== undefined
      ? deps.currentProfile
      : getMultimodelProfile()
    : null
  const base = inForce ?? profileForAccount(split.account, store, env)!
  const m = split.model || base.model
  return {
    accountId: split.account,
    profile: { ...base, model: m, smallModel: m },
    model: m,
    current: isCurrent,
  }
}

/** routeForModel that never throws (display and bookkeeping paths). */
export function tryRouteForModel(
  model: string | undefined | null,
  deps: RouteDeps = {},
): ModelRoute | null {
  try {
    return routeForModel(model, deps)
  } catch {
    return null
  }
}

/** Pure: the account to show next to an agent, only when it differs from the session's. */
export function accountTag(
  route: Pick<ModelRoute, 'accountId'> | null,
  sessionAccount: string,
): string | undefined {
  return route && route.accountId !== sessionAccount ? route.accountId : undefined
}

// ── runtime ─────────────────────────────────────────────────────────────

/** Account in force: the request scope's, else the session's. */
export function currentAccountId(env: Env = process.env): string {
  return getScopedAccountId() ?? env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
}

/** The session's account, ignoring request scopes. */
export function sessionAccountId(env: Env = process.env): string {
  return env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
}

function claudeDefaults(): ClaudeDefaults {
  const ms = getModelStrings()
  return {
    opus: claudeAliasApiId('opus') ?? ms.opus46,
    sonnet: claudeAliasApiId('sonnet') ?? ms.sonnet46,
    haiku: claudeAliasApiId('haiku') ?? ms.haiku45,
  }
}

let storeCache: { path: string; mtimeMs: number; store: AccountStore } | undefined

/** accounts.json, re-read only when the file changes (routing runs per request). */
function cachedStore(env: Env): AccountStore {
  const path = accountsFilePath(env)
  let mtimeMs = -1
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    // No file: an empty store, cached like any other.
  }
  if (storeCache?.path === path && storeCache.mtimeMs === mtimeMs) return storeCache.store
  const store = loadStore(path)
  storeCache = { path, mtimeMs, store }
  return store
}

export function resetAccountRoutingForTesting(): void {
  storeCache = undefined
}

function scopeFor(route: ModelRoute): ProfileScope {
  return { accountId: route.accountId, profile: route.profile, live: true }
}

/**
 * Runs `fn` with the model stripped of its prefix and, when the route points
 * to another account, inside that account's scope. Sync or async `fn`.
 */
export function withModelRoute<T>(
  model: string,
  fn: (model: string) => T,
  route: ModelRoute | null = tryRouteForModel(model),
): T {
  if (!route) return fn(model)
  if (route.current) return fn(route.model)
  const scope = scopeFor(route)
  let result: T
  try {
    result = runInProfileScope(scope, () => fn(route.model))
  } catch (err) {
    scope.live = false
    throw err
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      scope.live = false
    }) as T
  }
  scope.live = false
  return result
}

/** Generator form of withModelRoute, for the streaming request path. */
export function withModelRouteGenerator<T, R>(
  route: ModelRoute,
  make: (model: string) => AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  if (route.current) return make(route.model)
  const scope = scopeFor(route)
  return scopeGenerator(scope, runInProfileScope(scope, () => make(route.model)))
}

/**
 * `cuenta:modelo` with the model resolved (`claude:haiku` →
 * `claude:claude-haiku-4-5-…`, `qwen36:` → `qwen36:<its model>`), or
 * undefined when `spec` has no account prefix. Throws on an account that
 * cannot serve.
 */
export function canonicalRoutedModel(spec: string | undefined, deps: RouteDeps = {}): string | undefined {
  const route = spec ? routeForModel(spec, deps) : null
  return route ? `${route.accountId}:${route.model}` : undefined
}
