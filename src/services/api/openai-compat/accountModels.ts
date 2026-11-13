/**
 * Models available to one account: the models.dev catalog of its provider
 * united with `GET {baseUrl}/models` of the server. For local servers
 * (llama.cpp, Ollama, LM Studio) the server is the only source, since only it
 * knows what is loaded; the catalog just enriches matching ids with limits.
 */

import {
  accountsFilePath,
  isLocalUrl,
  loadStore,
  profileForAccount,
  type AccountStore,
} from './accounts.js'
import { findProvider, type Catalog, type CatalogModel } from './catalog.js'
import { loadCatalog } from './catalogStore.js'
import type { MultimodelProfile } from './profiles.js'

type Env = Record<string, string | undefined>

export type AccountModel = CatalogModel & {
  /** Where the id came from. */
  source: 'catalog' | 'server'
}

/** What listAccountModels needs to know about an account. */
export type ModelTarget = {
  id: string
  provider: string
  baseUrl: string
  apiKey?: string
  /** models.dev provider id, when the provider has one. */
  catalogProvider?: string
}

export type ListDeps = {
  fetchImpl?: typeof fetch
  catalog?: Catalog
  /** Query hosted servers too (default true). The header counter passes false: no key leaves the machine at startup. */
  remote?: boolean
  now?: number
}

const LOCAL_TIMEOUT_MS = 800
const REMOTE_TIMEOUT_MS = 3000
const CACHE_TTL_MS = 5 * 60 * 1000

/** What a server's /models says about one model (everything but the id optional). */
export type ServerModel = Partial<Omit<CatalogModel, 'id' | 'reasoning' | 'image'>> & {
  id: string
  reasoning?: boolean
  image?: boolean
}

type CacheEntry = { at: number; ids: ServerModel[]; withRemote: boolean }
const serverCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ServerModel[]>>()

export function clearAccountModelsCache(): void {
  serverCache.clear()
  inflight.clear()
}

export function targetFromProfile(id: string, p: MultimodelProfile): ModelTarget {
  return { id, provider: p.provider, baseUrl: p.baseUrl, apiKey: p.apiKey, catalogProvider: p.catalogProvider }
}

/** Resolves an account id to a target, or null for the native Claude account. */
export function targetForAccount(id: string, store: AccountStore, env: Env): ModelTarget | null {
  const p = profileForAccount(id, store, env)
  return p ? targetFromProfile(id, p) : null
}

const num = (x: unknown): number | undefined => (typeof x === 'number' && x > 0 ? x : undefined)

/**
 * Pure: models out of a `/models` response (OpenAI `data[]`, llama.cpp `models[]`),
 * keeping whatever metadata the server volunteers: Venice (`context_length`,
 * `model_spec`), llama.cpp (`meta.n_ctx`), OpenRouter (`context_length`, `pricing`).
 */
export function parseServerModels(body: unknown): ServerModel[] {
  const b = body as { data?: unknown; models?: unknown } | null
  const list = Array.isArray(b?.data) ? b!.data : Array.isArray(b?.models) ? b!.models : []
  const out = new Map<string, ServerModel>()
  for (const x of list as unknown[]) {
    if (typeof x === 'string') {
      if (x) out.set(x, { id: x })
      continue
    }
    const r = (x ?? {}) as Record<string, any>
    const id = r.id ?? r.model ?? r.name
    if (typeof id !== 'string' || !id) continue
    const spec = r.model_spec ?? {}
    const caps = spec.capabilities ?? {}
    const per = (v: unknown) => (typeof v === 'number' ? v : undefined)
    const orPrice = (v: unknown) => (v !== undefined && !isNaN(Number(v)) ? Number(v) * 1_000_000 : undefined)
    const m: ServerModel = {
      id,
      name: typeof spec.name === 'string' ? spec.name : typeof r.name === 'string' && r.name !== id ? r.name : undefined,
      contextWindow: num(spec.availableContextTokens) ?? num(r.context_length) ?? num(r.meta?.n_ctx) ?? num(r.top_provider?.context_length),
      maxOutputTokens: num(spec.maxCompletionTokens) ?? num(r.top_provider?.max_completion_tokens),
      costInput: per(spec.pricing?.input?.usd) ?? orPrice(r.pricing?.prompt),
      costOutput: per(spec.pricing?.output?.usd) ?? orPrice(r.pricing?.completion),
      reasoning: caps.supportsReasoning ?? (Array.isArray(r.capabilities) ? r.capabilities.includes('thinking') : undefined),
      image: caps.supportsVision ?? (Array.isArray(r.capabilities) ? r.capabilities.includes('vision') : undefined),
      description: typeof spec.description === 'string' ? spec.description : undefined,
    }
    out.set(id, Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as ServerModel)
  }
  return [...out.values()]
}

/** Pure: ids out of a `/models` response. */
export function parseServerModelIds(body: unknown): string[] {
  return parseServerModels(body).map(m => m.id)
}

/** Pure: catalog ∪ server models for a target. Local servers: server only (enriched). Server data wins over the catalog. */
export function mergeModels(target: ModelTarget, serverModels: Array<string | ServerModel>, catalog: Catalog): AccountModel[] {
  const cat = target.catalogProvider ? findProvider(catalog, target.catalogProvider)?.models ?? [] : []
  const byId = new Map(cat.map(m => [m.id, m]))
  const local = isLocalUrl(target.baseUrl)
  const out: AccountModel[] = []
  if (!local) for (const m of cat) out.push({ ...m, source: 'catalog' })
  const seen = new Map(out.map((m, i) => [m.id, i]))
  for (const sm of serverModels) {
    const s: ServerModel = typeof sm === 'string' ? { id: sm } : sm
    const known = byId.get(s.id)
    const merged: AccountModel = {
      ...(known ?? { id: s.id, name: s.id, reasoning: false, image: false }),
      ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)),
      source: 'server',
    } as AccountModel
    if (!merged.name) merged.name = s.id
    const i = seen.get(s.id)
    if (i !== undefined) {
      out[i] = { ...merged, source: out[i]!.source }
    } else {
      seen.set(s.id, out.length)
      out.push(merged)
    }
  }
  return out
}

function cacheKey(t: ModelTarget): string {
  return `${t.id}|${t.baseUrl}`
}

function usable(entry: CacheEntry | undefined, t: ModelTarget, wantRemote: boolean, now: number): entry is CacheEntry {
  if (!entry || now - entry.at > CACHE_TTL_MS) return false
  return entry.withRemote || !wantRemote || isLocalUrl(t.baseUrl)
}

/** Sync, no network: catalog plus whatever the server returned last time. */
export function accountModelsSync(target: ModelTarget, catalog: Catalog = loadCatalog()): AccountModel[] {
  return mergeModels(target, serverCache.get(cacheKey(target))?.ids ?? [], catalog)
}

async function fetchServerIds(t: ModelTarget, fetchImpl: typeof fetch): Promise<ServerModel[]> {
  const local = isLocalUrl(t.baseUrl)
  const res = await fetchImpl(`${t.baseUrl}/models`, {
    headers: t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : undefined,
    signal: AbortSignal.timeout(local ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const models = parseServerModels(await res.json())
  return local ? enrichOllama(t, models, fetchImpl) : models
}

/** Ollama's /v1/models has no limits; its native /api/show does. Best effort, local only. */
async function enrichOllama(t: ModelTarget, models: ServerModel[], fetchImpl: typeof fetch): Promise<ServerModel[]> {
  if (!/:11434\//.test(t.baseUrl + '/') || models.every(m => m.contextWindow)) return models
  const root = t.baseUrl.replace(/\/v1\/?$/, '')
  return Promise.all(
    models.map(async m => {
      if (m.contextWindow) return m
      try {
        const r = await fetchImpl(`${root}/api/show`, {
          method: 'POST',
          body: JSON.stringify({ model: m.id }),
          signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
        })
        if (!r.ok) return m
        const d = (await r.json()) as { model_info?: Record<string, unknown>; capabilities?: string[] }
        const key = Object.keys(d.model_info ?? {}).find(k => k.endsWith('.context_length'))
        const caps = d.capabilities ?? []
        return {
          ...m,
          contextWindow: key ? num(d.model_info![key]) : undefined,
          reasoning: caps.includes('thinking') || undefined,
          image: caps.includes('vision') || undefined,
        } as ServerModel
      } catch {
        return m
      }
    }),
  )
}

/**
 * Models of an account. Queries the server (short timeout, cached per account
 * for 5 minutes); a failing server just means catalog-only.
 */
export async function listAccountModels(target: ModelTarget, deps: ListDeps = {}): Promise<AccountModel[]> {
  const catalog = deps.catalog ?? loadCatalog()
  const wantRemote = deps.remote !== false
  const now = deps.now ?? Date.now()
  const key = cacheKey(target)
  const cached = serverCache.get(key)
  if (usable(cached, target, wantRemote, now)) return mergeModels(target, cached.ids, catalog)

  if (!wantRemote && !isLocalUrl(target.baseUrl)) return mergeModels(target, cached?.ids ?? [], catalog)

  let pending = inflight.get(key)
  if (!pending) {
    pending = fetchServerIds(target, deps.fetchImpl ?? fetch)
      .catch(() => [] as string[])
      .then(ids => {
        serverCache.set(key, { at: now, ids, withRemote: wantRemote })
        return ids
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return mergeModels(target, await pending, catalog)
}

/** Total models across the given connected account ids. */
export async function countModels(
  ids: string[],
  store: AccountStore,
  env: Env,
  deps: ListDeps = {},
): Promise<number> {
  const counts = await Promise.all(
    ids.map(async id => {
      try {
        const t = targetForAccount(id, store, env)
        return t ? (await listAccountModels(t, deps)).length : 0
      } catch {
        return 0
      }
    }),
  )
  return counts.reduce((a, b) => a + b, 0)
}

/** "128k ctx · 16k out · $1.2/$4.8 por M · razonamiento · imagen", only what is known ('' when nothing is). */
export function modelStats(m: CatalogModel): string {
  const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  const price = (n: number) => `$${+n.toFixed(2)}`
  const parts: string[] = []
  if (m.contextWindow) parts.push(`${k(m.contextWindow)} ctx`)
  if (m.maxOutputTokens) parts.push(`${k(m.maxOutputTokens)} out`)
  if (m.costInput !== undefined && m.costOutput !== undefined) parts.push(`${price(m.costInput)}/${price(m.costOutput)} por M`)
  else if (m.costInput === 0 && m.costOutput === 0) parts.push('gratis')
  if (m.reasoning) parts.push('razonamiento')
  if (m.image) parts.push('imagen')
  return parts.join(' · ')
}

/** The stats plus the first sentence of the catalog description. */
export function describeModel(m: CatalogModel): string {
  const stats = modelStats(m)
  const flat = m.description ? m.description.replace(/\s+/g, ' ').trim() : ''
  const first = flat.split(/(?<=\.)\s/)[0] ?? ''
  const note = first.length > 110 ? `${first.slice(0, 107)}...` : first
  if (stats && note) return `${stats} — ${note}`
  return stats || note || 'sin datos del catálogo'
}

/** Active account target for the current process, or null on the Claude account. */
export function activeTarget(env: Env = process.env): ModelTarget | null {
  const id = env.FNHARNESS_ACCOUNT
  if (!id || id === 'claude') return null
  try {
    if (loadStore(accountsFilePath(env)).accounts[id]?.kind === 'anthropic') return null
    return targetForAccount(id, loadStore(accountsFilePath(env)), env)
  } catch {
    return null
  }
}

