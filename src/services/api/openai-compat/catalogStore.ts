/**
 * models.dev catalog: embedded snapshot, disk cache and background refresh.
 *
 * Startup only reads the disk (cache first, embedded snapshot as fallback), so
 * it never waits on the network. refreshCatalogInBackground() fetches
 * https://models.dev/api.json when the cache is older than 24 h and never
 * throws. The fetch deliberately ignores CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
 * (multimodel mode always sets it); FNHARNESS_DISABLE_MODELS_FETCH=1 turns it off.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import snapshot from './catalog.snapshot.json'
import { parseCatalog, trimCatalog, type Catalog, type RawCatalog } from './catalog.js'

type Env = Record<string, string | undefined>

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json'

type CacheFile = { fetchedAt: number; catalog: RawCatalog }

export function catalogCachePath(env: Env = process.env): string | null {
  const dir = env.CLAUDE_CONFIG_DIR
  return dir ? join(dir, 'models.json') : null
}

/** Reads the disk cache; null when missing or corrupt. */
export function readCatalogCache(path: string | null): CacheFile | null {
  if (!path) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
    if (typeof raw.fetchedAt === 'number' && raw.catalog && typeof raw.catalog === 'object') return raw
  } catch {}
  return null
}

/** Pure: is the cache missing or older than the TTL? */
export function isCacheStale(cache: CacheFile | null, now = Date.now(), ttl = CATALOG_TTL_MS): boolean {
  return !cache || now - cache.fetchedAt >= ttl
}

let memo: Catalog | undefined

/** Sync, disk-only: cache if present, else the embedded snapshot. Memoized. */
export function loadCatalog(env: Env = process.env): Catalog {
  if (memo) return memo
  const cache = readCatalogCache(catalogCachePath(env))
  memo = parseCatalog(cache?.catalog ?? snapshot)
  return memo
}

/** Drops the memoized catalog so the next loadCatalog() re-reads the disk. */
export function resetCatalogMemo(): void {
  memo = undefined
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

/**
 * Refreshes the disk cache when stale. Resolves true when a new catalog was
 * written. All failures are swallowed: the old cache / snapshot keeps working.
 */
export async function refreshCatalog(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now = Date.now(),
): Promise<boolean> {
  if (env.FNHARNESS_DISABLE_MODELS_FETCH === '1') return false
  const path = catalogCachePath(env)
  if (!path || !isCacheStale(readCatalogCache(path), now)) return false
  try {
    const res = await fetchImpl(env.FNHARNESS_MODELS_URL || DEFAULT_CATALOG_URL, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return false
    const trimmed = trimCatalog(await res.json())
    if (Object.keys(trimmed).length === 0) return false
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ fetchedAt: now, catalog: trimmed } satisfies CacheFile))
    renameSync(tmp, path) // atomic: several sessions may refresh at once
    resetCatalogMemo()
    return true
  } catch {
    return false
  }
}

/** Fire-and-forget refresh; never blocks startup. */
export function refreshCatalogInBackground(env: Env = process.env): void {
  const t = setTimeout(() => void refreshCatalog(env), 0)
  ;(t as { unref?: () => void }).unref?.()
}

/** Size helper for the snapshot script's report. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
