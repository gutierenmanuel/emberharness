/**
 * Multimodel provider profiles
 *
 * Resolves which non-Anthropic backend (if any) the harness talks to. Every
 * backend here speaks the OpenAI Chat Completions wire format, which covers
 * local servers (Ollama, llama.cpp, LM Studio) and most hosted APIs (OpenAI,
 * OpenRouter, Groq, DeepSeek, Gemini, Mistral, Together).
 *
 * Selection is purely environment-driven so it composes with the existing
 * Claude Code flags and settings:
 *
 *   CLAUDE_MULTIMODEL_PROVIDER   preset name (see PROVIDER_PRESETS) or "custom"
 *   CLAUDE_MULTIMODEL_BASE_URL   overrides the preset URL (required for custom)
 *   CLAUDE_MULTIMODEL_API_KEY    overrides the preset key env var
 *   CLAUDE_MULTIMODEL_MODEL      main model id sent to the backend
 *   CLAUDE_MULTIMODEL_SMALL_MODEL  model for background/cheap calls (defaults to MODEL)
 */

import { AsyncLocalStorage } from 'async_hooks'
import { catalogIdFor, findProvider, modelLimits, type Catalog } from './catalog.js'
import { loadCatalog } from './catalogStore.js'
import { getServerInfo, refreshServerInfo } from './statusInfo.js'
import {
  accountsFilePath,
  loadStore,
  profileForAccount,
  startupAccountId,
  type StoredAccount,
} from './accounts.js'

export type ProviderPreset = {
  /** Extra env vars that may hold the key (catalog providers list several). */
  extraKeyEnvs?: string[]
  /** Human readable label shown in the CLI header. */
  label: string
  baseUrl: string
  /** Env var the key is read from when CLAUDE_MULTIMODEL_API_KEY is unset. */
  apiKeyEnv?: string
  /** Whether the backend works without any key (local servers). */
  keyOptional: boolean
  defaultModel: string
  /** OpenAI proper rejects `max_tokens` on newer models. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens'
  /** Real context window of the backend; drives auto-compact (defaults to the Claude value). */
  contextWindow?: number
  /** Default max output tokens; keep it small on short-context local models. */
  maxOutputTokens?: number
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    keyOptional: true,
    defaultModel: 'qwen3:8b',
    maxTokensParam: 'max_tokens',
  },
  llamacpp: {
    label: 'llama.cpp server',
    baseUrl: 'http://localhost:8082/v1',
    keyOptional: true,
    defaultModel: 'default',
    maxTokensParam: 'max_tokens',
  },
  qwen36: {
    label: 'Qwen3.6 35B heretic (local)',
    // Through llm-tap (:8090) so requests show up in reports/llm_monitor.html;
    // the llama-server itself listens on :8082.
    baseUrl: 'http://localhost:8090/v1',
    keyOptional: true,
    defaultModel: 'qwen36-35b-heretic-q4km',
    maxTokensParam: 'max_tokens',
    contextWindow: 32768,
    maxOutputTokens: 4096,
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    keyOptional: true,
    defaultModel: 'default',
    maxTokensParam: 'max_tokens',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    keyOptional: false,
    defaultModel: 'gpt-4.1',
    maxTokensParam: 'max_completion_tokens',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyOptional: false,
    defaultModel: 'anthropic/claude-sonnet-4.5',
    maxTokensParam: 'max_tokens',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    keyOptional: false,
    defaultModel: 'llama-3.3-70b-versatile',
    maxTokensParam: 'max_tokens',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    keyOptional: false,
    defaultModel: 'deepseek-chat',
    maxTokensParam: 'max_tokens',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    keyOptional: false,
    defaultModel: 'gemini-2.5-pro',
    maxTokensParam: 'max_tokens',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    keyOptional: false,
    defaultModel: 'mistral-large-latest',
    maxTokensParam: 'max_tokens',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    keyOptional: false,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    maxTokensParam: 'max_tokens',
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    keyOptional: true,
    defaultModel: 'default',
    maxTokensParam: 'max_tokens',
  },
}

export type MultimodelProfile = {
  provider: string
  label: string
  baseUrl: string
  apiKey: string | undefined
  model: string
  smallModel: string
  maxTokensParam: 'max_tokens' | 'max_completion_tokens'
  contextWindow?: number
  maxOutputTokens?: number
  /** Id of this provider in the models.dev catalog, when it has one. */
  catalogProvider?: string
}

type Env = Record<string, string | undefined>

export class MultimodelConfigError extends Error {}

/**
 * Pure: derives the active profile from an env snapshot, or null when the
 * harness should talk to Anthropic as usual. Throws MultimodelConfigError for
 * a half-configured provider so the user gets one clear message at startup
 * instead of an opaque 401 mid-conversation.
 */
export function resolveProfile(env: Env, catalog?: Catalog): MultimodelProfile | null {
  const provider = env.CLAUDE_MULTIMODEL_PROVIDER?.trim().toLowerCase()
  if (!provider) return null

  const preset = PROVIDER_PRESETS[provider] ?? presetFromCatalog(provider, catalog ?? loadCatalog(env))
  if (!preset) {
    throw new MultimodelConfigError(
      `Unknown provider "${provider}". Available: ${Object.keys(PROVIDER_PRESETS).join(', ')}, or any OpenAI-compatible provider of the catalog (/account catalog)`,
    )
  }

  const baseUrl = (env.CLAUDE_MULTIMODEL_BASE_URL || preset.baseUrl).replace(
    /\/+$/,
    '',
  )
  if (!baseUrl) {
    throw new MultimodelConfigError(
      `Provider "${provider}" needs CLAUDE_MULTIMODEL_BASE_URL`,
    )
  }

  const apiKey =
    env.CLAUDE_MULTIMODEL_API_KEY ||
    (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined) ||
    (preset.extraKeyEnvs ?? []).map(k => env[k]).find(Boolean) ||
    undefined
  if (!apiKey && !preset.keyOptional) {
    throw new MultimodelConfigError(
      `Provider "${provider}" needs an API key: set ${preset.apiKeyEnv} or CLAUDE_MULTIMODEL_API_KEY`,
    )
  }

  const model = env.CLAUDE_MULTIMODEL_MODEL || preset.defaultModel
  return {
    provider,
    label: preset.label,
    baseUrl,
    apiKey,
    model,
    smallModel: env.CLAUDE_MULTIMODEL_SMALL_MODEL || model,
    maxTokensParam: preset.maxTokensParam,
    contextWindow: preset.contextWindow,
    maxOutputTokens: preset.maxOutputTokens,
    // Local servers and custom URLs have no catalog entry; hosted ones do.
    catalogProvider: provider === 'custom' || /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(baseUrl) ? undefined : catalogIdFor(provider),
  }
}

/** A preset derived from a catalog provider (OpenAI-compatible ones only), or undefined. */
function presetFromCatalog(provider: string, catalog: Catalog): (ProviderPreset & { extraKeyEnvs?: string[] }) | undefined {
  const p = findProvider(catalog, provider)
  if (!p || p.kind !== 'openai' || !p.baseUrl) return undefined
  return {
    label: p.name,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.env[0],
    extraKeyEnvs: p.env.slice(1),
    keyOptional: false,
    defaultModel: p.models[0]?.id ?? 'default',
    maxTokensParam: p.id === 'openai' ? 'max_completion_tokens' : 'max_tokens',
  }
}

/**
 * Context window and max output for `model` on `profile`: an explicit value
 * on the profile (local presets such as qwen36 pin the server's real window)
 * wins; otherwise the models.dev catalog; otherwise undefined.
 */
export function getModelLimits(
  profile: MultimodelProfile | null,
  model: string,
  catalog?: Catalog,
): { contextWindow?: number; maxOutputTokens?: number } {
  if (!profile) return {}
  const fromCatalog = profile.catalogProvider
    ? modelLimits(catalog ?? loadCatalog(), profile.catalogProvider, model)
    : undefined
  // A local server that reported its real n_ctx (GET /props) is the truth.
  const serverCtx = getServerInfo(profile.baseUrl)?.nCtx ?? undefined
  const contextWindow = serverCtx ?? profile.contextWindow ?? fromCatalog?.contextWindow
  let maxOutputTokens = profile.maxOutputTokens ?? fromCatalog?.maxOutputTokens
  // A short window with no output cap would reserve the Claude default (32k)
  // for the answer and push auto-compact below zero: a quarter of it instead.
  if (maxOutputTokens === undefined && contextWindow !== undefined && contextWindow <= SMALL_WINDOW) {
    maxOutputTokens = Math.floor(contextWindow / 4)
  }
  return { contextWindow, maxOutputTokens }
}

/** Windows up to this size count as "short" (local models) for the default output cap. */
const SMALL_WINDOW = 65_536

let cachedProfile: MultimodelProfile | null | undefined

/**
 * Per-request account scope. A request whose model carries an account prefix
 * (`qwen36:model`, `claude:haiku`) runs inside one of these, so everything it
 * touches (client, auth gating, betas, limits, cost) sees that account while
 * the session keeps its own. `live` drops to false when the request ends, so
 * timers or promises created inside it and firing later fall back to the
 * session account instead of carrying the scope forever.
 */
export type ProfileScope = {
  accountId: string
  profile: MultimodelProfile | null
  live: boolean
}

const profileScope = new AsyncLocalStorage<ProfileScope>()

function liveScope(): ProfileScope | undefined {
  const s = profileScope.getStore()
  return s?.live ? s : undefined
}

/** Account id of the request scope in force, or undefined outside one. */
export function getScopedAccountId(): string | undefined {
  return liveScope()?.accountId
}

/** Runs `fn` (sync, or async until its promise settles) inside `scope`. */
export function runInProfileScope<T>(scope: ProfileScope, fn: () => T): T {
  return profileScope.run(scope, fn)
}

/**
 * Wraps an async generator so every resumption of its body runs inside
 * `scope` (AsyncLocalStorage does not follow a generator across `next()`
 * calls made from outside). The scope dies when the generator finishes.
 */
export function scopeGenerator<T, R>(
  scope: ProfileScope,
  gen: AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  const settle = async (
    step: () => Promise<IteratorResult<T, R>>,
  ): Promise<IteratorResult<T, R>> => {
    try {
      const r = await profileScope.run(scope, step)
      if (r.done) scope.live = false
      return r
    } catch (err) {
      scope.live = false
      throw err
    }
  }
  const wrapped: AsyncGenerator<T, R> = {
    next: (...args) => settle(() => gen.next(...args)),
    return: value => settle(() => gen.return(value)),
    throw: err => settle(() => gen.throw(err)),
    [Symbol.asyncIterator]() {
      return wrapped
    },
  } as AsyncGenerator<T, R>
  return wrapped
}

export function getMultimodelProfile(): MultimodelProfile | null {
  const scope = liveScope()
  if (scope) return scope.profile
  if (cachedProfile === undefined) {
    cachedProfile = resolveProfile(process.env)
  }
  return cachedProfile
}

export function isMultimodelActive(): boolean {
  return getMultimodelProfile() !== null
}

/** Env slots the harness reads to pick models; saved once so "claude" can restore them. */
const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
let originalModelEnv: Env | undefined

/**
 * The model env slots as they were before any multimodel account rewrote
 * them: what `claude:<alias>` resolves against while the session runs on
 * another account.
 */
export function getOriginalModelEnv(env: Env = process.env): Env {
  return originalModelEnv ?? Object.fromEntries(MODEL_ENV_KEYS.map(k => [k, env[k]]))
}

/** Tests only: forget the saved env slots and the cached profile. */
export function resetActiveProfileForTesting(): void {
  originalModelEnv = undefined
  cachedProfile = undefined
}

/**
 * Makes `profile` the live backend (null = native Anthropic) and primes the
 * environment so model resolution, auth gating and telemetry behave as if
 * every model slot were that backend's model. Safe to call repeatedly, which
 * is what lets /account switch backends mid-session.
 */
export function setActiveProfile(
  profile: MultimodelProfile | null,
  accountId: string,
  env: Env = process.env,
): void {
  originalModelEnv ??= Object.fromEntries(MODEL_ENV_KEYS.map(k => [k, env[k]]))
  cachedProfile = profile

  const slots: Env = profile
    ? {
        ANTHROPIC_MODEL: profile.model,
        ANTHROPIC_SMALL_FAST_MODEL: profile.smallModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.smallModel,
      }
    : originalModelEnv
  for (const key of MODEL_ENV_KEYS) {
    if (slots[key] === undefined) delete env[key]
    else env[key] = slots[key]
  }

  // Exposed to child processes such as the statusline command.
  env.FNHARNESS_ACCOUNT = accountId
  env.FNHARNESS_ACCOUNT_LABEL = profile?.label ?? 'Claude'
  env.FNHARNESS_MODEL_BACKEND = profile?.baseUrl ?? 'api.anthropic.com'
  if (profile) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ||= '1'
    env.DISABLE_TELEMETRY ||= '1'
  }
  // Learn the real window of a local server in the background (cached, TTL).
  refreshServerInfo(profile?.baseUrl, env)
}

/**
 * Called once, before anything else reads the environment. An explicit
 * CLAUDE_MULTIMODEL_PROVIDER wins; otherwise the account chosen with
 * CLAUDE_MULTIMODEL_ACCOUNT or persisted by /account is used.
 */
export function applyMultimodelEnv(env: Env = process.env): void {
  try {
    if (env.CLAUDE_MULTIMODEL_PROVIDER) {
      const profile = resolveProfile(env)
      setActiveProfile(profile, env.CLAUDE_MULTIMODEL_PROVIDER, env)
      return
    }
    const store = loadStore(accountsFilePath(env))
    const id = startupAccountId(store, env)
    // Launch flags (--model, --base-url, ...) tune the startup account for
    // this run only; they are never written back to accounts.json.
    const launch: StoredAccount = {}
    if (env.CLAUDE_MULTIMODEL_BASE_URL) launch.baseUrl = env.CLAUDE_MULTIMODEL_BASE_URL
    if (env.CLAUDE_MULTIMODEL_API_KEY) launch.apiKey = env.CLAUDE_MULTIMODEL_API_KEY
    if (env.CLAUDE_MULTIMODEL_MODEL) launch.model = env.CLAUDE_MULTIMODEL_MODEL
    if (env.CLAUDE_MULTIMODEL_SMALL_MODEL) launch.smallModel = env.CLAUDE_MULTIMODEL_SMALL_MODEL
    store.accounts[id] = { ...store.accounts[id], ...launch }
    setActiveProfile(profileForAccount(id, store, env), id, env)
  } catch (err) {
    if (err instanceof MultimodelConfigError) {
      process.stderr.write(`fnharness: ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
}
