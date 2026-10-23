/**
 * models.dev catalog: pure parsing, filtering and provider mapping.
 *
 * The catalog (https://models.dev/api.json, the same data opencode uses) is an
 * object `{ [providerId]: { id, name, env[], npm, api?, models: {...} } }`.
 * Nothing in this file touches the disk or the network; see catalogStore.ts
 * for the cache, the embedded snapshot and the background refresh.
 */

/** A provider/model as stored in the cache and in the embedded snapshot (trimmed raw shape). */
export type RawModel = {
  id?: string
  name?: string
  type?: string
  status?: string
  tool_call?: boolean
  reasoning?: boolean
  release_date?: string
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  provider?: { api?: string; shape?: string; npm?: string }
}

export type RawProvider = {
  id?: string
  name?: string
  env?: string[]
  npm?: string
  api?: string
  models?: Record<string, RawModel>
}

export type RawCatalog = Record<string, RawProvider>

export type CatalogModel = {
  id: string
  name: string
  /** Tokens; undefined when the catalog does not say. */
  contextWindow?: number
  maxOutputTokens?: number
  /** USD per million tokens. */
  costInput?: number
  costOutput?: number
  reasoning: boolean
  image: boolean
  releaseDate?: string
}

/** How fnharness can talk to a provider. */
export type CompatKind = 'openai' | 'anthropic' | 'other'

export type CatalogProvider = {
  id: string
  name: string
  /** Env vars that may hold the key, in preference order. */
  env: string[]
  npm: string
  kind: CompatKind
  /** OpenAI-compatible base URL, or null when unknown / not OpenAI-compatible. */
  baseUrl: string | null
  /** Chat models with tool calling, not deprecated. */
  models: CatalogModel[]
}

export type Catalog = Record<string, CatalogProvider>

/**
 * Providers whose SDK hides the endpoint, so the catalog carries no `api`.
 * All of them expose an OpenAI-compatible chat endpoint.
 */
export const KNOWN_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  togetherai: 'https://api.together.xyz/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  xai: 'https://api.x.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  perplexity: 'https://api.perplexity.ai',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
}

/** fnharness preset names that differ from the catalog's provider ids. */
export const PRESET_TO_CATALOG: Record<string, string> = {
  gemini: 'google',
  together: 'togetherai',
}

const OPENAI_COMPAT_NPM = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
  '@openrouter/ai-sdk-provider',
  'merge-gateway-ai-sdk-provider',
])

/** Catalog id for a fnharness provider/preset name. */
export function catalogIdFor(provider: string): string {
  return PRESET_TO_CATALOG[provider] ?? provider
}

/** Pure: which wire protocol a provider speaks, from its SDK package and known endpoints. */
export function compatKind(id: string, raw: RawProvider): CompatKind {
  const npm = raw.npm ?? ''
  if (npm === '@ai-sdk/anthropic') return 'anthropic'
  if (id in KNOWN_BASE_URLS) return 'openai'
  if (OPENAI_COMPAT_NPM.has(npm) && raw.api) return 'openai'
  return 'other'
}

/** Pure: OpenAI-compatible base URL (trailing slashes trimmed) or null. */
export function resolveBaseUrl(id: string, raw: RawProvider): string | null {
  if (compatKind(id, raw) !== 'openai') return null
  const url = raw.api || KNOWN_BASE_URLS[id]
  return url ? url.replace(/\/+$/, '') : null
}

/**
 * Pure: is this a chat model fnharness can drive? Needs tool calling, must not
 * be deprecated, and must not be pinned to another endpoint or the Responses API.
 */
export function isUsableChatModel(m: RawModel): boolean {
  if (m.type && m.type !== 'chat') return false
  if (m.status === 'deprecated') return false
  if (m.tool_call !== true) return false
  if (m.provider?.shape === 'responses') return false
  if (m.provider?.api) return false
  return true
}

export function normalizeModel(key: string, m: RawModel): CatalogModel {
  return {
    id: m.id || key,
    name: m.name || m.id || key,
    contextWindow: positive(m.limit?.context),
    maxOutputTokens: positive(m.limit?.output),
    costInput: m.cost?.input,
    costOutput: m.cost?.output,
    reasoning: m.reasoning === true,
    image: m.modalities?.input?.includes('image') === true,
    releaseDate: m.release_date,
  }
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && n > 0 ? n : undefined
}

/** Pure: chat models of one raw provider, newest first. */
export function chatModels(raw: RawProvider): CatalogModel[] {
  return Object.entries(raw.models ?? {})
    .filter(([, m]) => isUsableChatModel(m))
    .map(([key, m]) => normalizeModel(key, m))
    .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.id.localeCompare(b.id))
}

/** Pure: builds the normalized catalog from the raw JSON (full or trimmed). */
export function parseCatalog(json: unknown): Catalog {
  const out: Catalog = {}
  if (!json || typeof json !== 'object') return out
  for (const [id, raw] of Object.entries(json as RawCatalog)) {
    if (!raw || typeof raw !== 'object') continue
    out[id] = {
      id,
      name: raw.name || id,
      env: Array.isArray(raw.env) ? raw.env : [],
      npm: raw.npm ?? '',
      kind: compatKind(id, raw),
      baseUrl: resolveBaseUrl(id, raw),
      models: chatModels(raw),
    }
  }
  return out
}

/**
 * Pure: drops everything fnharness does not use so the snapshot and the disk
 * cache stay small. Keeps only OpenAI-compatible providers and, per model, the
 * fields read by normalizeModel. The result is still valid input for parseCatalog.
 */
export function trimCatalog(json: unknown): RawCatalog {
  const out: RawCatalog = {}
  if (!json || typeof json !== 'object') return out
  for (const [id, raw] of Object.entries(json as RawCatalog)) {
    if (!raw || typeof raw !== 'object' || compatKind(id, raw) !== 'openai') continue
    const models: Record<string, RawModel> = {}
    for (const [key, m] of Object.entries(raw.models ?? {})) {
      if (!isUsableChatModel(m)) continue
      const t: RawModel = { name: m.name, tool_call: true }
      if (m.id && m.id !== key) t.id = m.id
      if (m.reasoning) t.reasoning = true
      if (m.release_date) t.release_date = m.release_date
      if (m.limit) t.limit = { context: m.limit.context, output: m.limit.output }
      if (m.cost && (m.cost.input !== undefined || m.cost.output !== undefined)) {
        t.cost = { input: m.cost.input, output: m.cost.output }
      }
      if (m.modalities?.input?.includes('image')) t.modalities = { input: ['image'] }
      models[key] = t
    }
    if (Object.keys(models).length === 0) continue
    out[id] = { id, name: raw.name, env: raw.env, npm: raw.npm, api: raw.api, models }
  }
  return out
}

/** Pure: a provider of the catalog by fnharness name (applies the gemini/together aliases). */
export function findProvider(catalog: Catalog, provider: string): CatalogProvider | undefined {
  return catalog[catalogIdFor(provider)]
}

/** Pure: context/output limits of a model, or undefined when unknown. */
export function modelLimits(
  catalog: Catalog,
  provider: string,
  model: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const m = findProvider(catalog, provider)?.models.find(x => x.id === model)
  if (!m || (!m.contextWindow && !m.maxOutputTokens)) return undefined
  return { contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens }
}

/** Pure: providers fnharness can use, with their model count, biggest first. */
export function usableProviders(catalog: Catalog): CatalogProvider[] {
  return Object.values(catalog)
    .filter(p => p.kind === 'openai' && p.baseUrl && p.models.length > 0)
    .sort((a, b) => b.models.length - a.models.length || a.id.localeCompare(b.id))
}
