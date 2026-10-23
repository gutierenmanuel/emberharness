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

type CacheEntry = { at: number; ids: string[]; withRemote: boolean }
const serverCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<string[]>>()

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

/** Pure: ids out of a `/models` response (OpenAI `data[]`, llama.cpp `models[]`). */
export function parseServerModelIds(body: unknown): string[] {
  const b = body as { data?: unknown; models?: unknown } | null
  const list = Array.isArray(b?.data) ? b!.data : Array.isArray(b?.models) ? b!.models : []
  const ids = (list as unknown[])
    .map(x => (typeof x === 'string' ? x : ((x as { id?: string; model?: string; name?: string })?.id ?? (x as { model?: string })?.model ?? (x as { name?: string })?.name)))
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
  return [...new Set(ids)]
}

/** Pure: catalog ∪ server ids for a target. Local servers: server ids only (enriched). */
export function mergeModels(target: ModelTarget, serverIds: string[], catalog: Catalog): AccountModel[] {
  const cat = target.catalogProvider ? findProvider(catalog, target.catalogProvider)?.models ?? [] : []
  const byId = new Map(cat.map(m => [m.id, m]))
  const local = isLocalUrl(target.baseUrl)
  const out: AccountModel[] = []
  if (!local) for (const m of cat) out.push({ ...m, source: 'catalog' })
  const seen = new Set(out.map(m => m.id))
  for (const id of serverIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const known = byId.get(id)
    out.push(known ? { ...known, source: 'server' } : { id, name: id, reasoning: false, image: false, source: 'server' })
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

async function fetchServerIds(t: ModelTarget, fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(`${t.baseUrl}/models`, {
    headers: t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : undefined,
    signal: AbortSignal.timeout(isLocalUrl(t.baseUrl) ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseServerModelIds(await res.json())
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

/** "128k ctx · 16k out · $1.2/$4.8 · reasoning · image", only what is known. */
export function describeModel(m: CatalogModel): string {
  const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  const price = (n: number) => `$${+n.toFixed(2)}`
  const parts: string[] = []
  if (m.contextWindow) parts.push(`${k(m.contextWindow)} ctx`)
  if (m.maxOutputTokens) parts.push(`${k(m.maxOutputTokens)} out`)
  if (m.costInput !== undefined && m.costOutput !== undefined) parts.push(`${price(m.costInput)}/${price(m.costOutput)} por M`)
  else if (m.costInput === 0 && m.costOutput === 0) parts.push('gratis')
  if (m.reasoning) parts.push('razonamiento')
  if (m.image) parts.push('imagen')
  return parts.join(' · ') || 'sin datos del catálogo'
}

/** Active account target for the current process, or null on the Claude account. */
export function activeTarget(env: Env = process.env): ModelTarget | null {
  const id = env.FNHARNESS_ACCOUNT
  if (!id || id === 'claude') return null
  try {
    return targetForAccount(id, loadStore(accountsFilePath(env)), env)
  } catch {
    return null
  }
}

