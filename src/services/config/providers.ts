/**
 * Provider presets as data: base URL, key variable, where the key lives
 * (`pass:` reference), default model and window of each OpenAI-compatible
 * backend, plus per-model overrides of window, output cap and prices.
 *
 * Defaults live in `config/defaults/providers.json`; the user's
 * `<config dir>/providers.json` layers over them and hot-reloads (hotJson.ts).
 * A provider id in the user file either tunes a built-in preset field by field
 * or, when it has a `baseUrl`, defines a new one. Shape:
 *
 *   {
 *     "keyRefTemplate": "pass:apis/{provider}",       // key of any provider without its own
 *     "providers": {
 *       "venice": {
 *         "keyRef": "pass:apis/venice",               // optional; wins over the template
 *         "models": { "deepseek-v4-1-flash-1017": { "contextWindow": 1000000,
 *                     "pricing": { "input": 0.5, "output": 1.5 } } }
 *       }
 *     }
 *   }
 *
 * Imports nothing from the harness (see claudeModels.ts for why).
 */

import defaultsJson from '../../config/defaults/providers.json'
import { createHotJson, isRecord, num, str } from './hotJson.js'
import { parsePrices, type ModelPrices } from './claudeModels.js'

/** Overrides for one model of a provider; whatever is set wins over the models.dev catalog. */
export type ModelOverride = {
  contextWindow?: number
  maxOutputTokens?: number
  pricing?: ModelPrices
}

export type ProviderPreset = {
  /** Extra env vars that may hold the key (catalog providers list several). */
  extraKeyEnvs?: string[]
  /** Human readable label shown in the CLI header. */
  label: string
  baseUrl: string
  /** Env var the key is read from when CLAUDE_MULTIMODEL_API_KEY is unset. */
  apiKeyEnv?: string
  /** `<manager>:<ref>` the key is read from when the account has no `apiKeyRef` (pass:apis/venice, ...). */
  keyRef?: string
  /** Whether the backend works without any key (local servers). */
  keyOptional: boolean
  defaultModel: string
  /** OpenAI proper rejects `max_tokens` on newer models. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens'
  /** Real context window of the backend; drives auto-compact (defaults to the Claude value). */
  contextWindow?: number
  /** Default max output tokens; keep it small on short-context local models. */
  maxOutputTokens?: number
  /** Per-model overrides of window, output cap and prices. */
  models?: Record<string, ModelOverride>
}

export type ProvidersConfig = {
  keyRefTemplate?: string
  providers: Record<string, ProviderPreset>
}

function parseModelOverrides(raw: unknown): Record<string, ModelOverride> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, ModelOverride> = {}
  for (const [id, m] of Object.entries(raw)) {
    if (!isRecord(m)) continue
    out[id] = {
      contextWindow: num(m.contextWindow),
      maxOutputTokens: num(m.maxOutputTokens),
      pricing: parsePrices(m.pricing),
    }
  }
  return out
}

/** Pure: one preset with the fields of `raw` laid over `base`; undefined when the result has no baseUrl. */
export function overlayPreset(base: ProviderPreset | undefined, id: string, raw: unknown): ProviderPreset | undefined {
  if (!isRecord(raw)) return base
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : base?.baseUrl
  if (baseUrl === undefined) return base
  const models = { ...base?.models }
  for (const [mid, o] of Object.entries(parseModelOverrides(raw.models) ?? {})) {
    models[mid] = { ...models[mid], ...stripUndefined(o) }
  }
  const extraKeyEnvs = Array.isArray(raw.extraKeyEnvs)
    ? raw.extraKeyEnvs.filter((v): v is string => typeof v === 'string')
    : base?.extraKeyEnvs
  return {
    label: str(raw.label) ?? base?.label ?? id,
    baseUrl,
    apiKeyEnv: str(raw.apiKeyEnv) ?? base?.apiKeyEnv,
    extraKeyEnvs,
    keyRef: str(raw.keyRef) ?? base?.keyRef,
    keyOptional: typeof raw.keyOptional === 'boolean' ? raw.keyOptional : base?.keyOptional ?? false,
    defaultModel: str(raw.defaultModel) ?? base?.defaultModel ?? 'default',
    maxTokensParam:
      raw.maxTokensParam === 'max_completion_tokens' || raw.maxTokensParam === 'max_tokens'
        ? raw.maxTokensParam
        : base?.maxTokensParam ?? 'max_tokens',
    contextWindow: num(raw.contextWindow) ?? base?.contextWindow,
    maxOutputTokens: num(raw.maxOutputTokens) ?? base?.maxOutputTokens,
    models: Object.keys(models).length ? models : undefined,
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * Pure: layers a parsed user file over the defaults. Throws when the top level
 * is not an object (the previous config is kept); a bad provider is skipped.
 */
export function mergeProviders(defaults: ProvidersConfig, user: unknown): ProvidersConfig {
  if (!isRecord(user)) throw new Error('el JSON debe ser un objeto')
  const providers = { ...defaults.providers }
  if (isRecord(user.providers)) {
    for (const [id, raw] of Object.entries(user.providers)) {
      const p = overlayPreset(providers[id], id, raw)
      if (p) providers[id] = p
    }
  }
  return { keyRefTemplate: str(user.keyRefTemplate) ?? defaults.keyRefTemplate, providers }
}

function parseDefaults(): ProvidersConfig {
  const raw = (defaultsJson as unknown as { providers: Record<string, unknown> }).providers
  return mergeProviders({ providers: {} }, { providers: raw })
}

const store = createHotJson<ProvidersConfig>({
  file: 'providers.json',
  defaults: parseDefaults(),
  merge: mergeProviders,
  // Lazy import: this module must stay free of harness dependencies.
  onError: msg => void import('../../utils/debug.js').then(m => m.logForDebugging(msg, { level: 'warn' })),
})

/** Presets by provider id (hot-reloaded). */
export function getProviderPresets(): Record<string, ProviderPreset> {
  return store.get().providers
}

/** Pure: `pass:apis/{provider}` with the provider id filled in. */
export function expandKeyRefTemplate(template: string, provider: string): string {
  return template.replaceAll('{provider}', provider)
}

/**
 * Where a provider's key lives when the account itself names none: the preset's
 * `keyRef`, else the file's `keyRefTemplate`. Undefined when neither is set.
 */
export function providerKeyRef(provider: string): string | undefined {
  const cfg = store.get()
  const own = cfg.providers[provider]?.keyRef
  if (own) return own
  return cfg.keyRefTemplate ? expandKeyRefTemplate(cfg.keyRefTemplate, provider) : undefined
}

/** Override for one model of a provider, if the user (or defaults) set one. */
export function providerModelOverride(provider: string, model: string): ModelOverride | undefined {
  return store.get().providers[provider]?.models?.[model]
}

/** Tests only. */
export function resetProvidersForTesting(): void {
  store.reset()
}
