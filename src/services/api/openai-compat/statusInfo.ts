/**
 * Data for the status bar that does not depend on Claude: which account is
 * active, the REAL context window of its backend, its output cap, whether a
 * local server answers and the last measured speed.
 *
 * The status bar command receives it as the `fnharness` object of its stdin
 * JSON (see components/StatusLine.tsx). Everything here is pure except the
 * small server-info cache at the bottom, which one cheap request refreshes in
 * the background with a TTL, so a 2 s refresh never waits for the network.
 *
 * llama.cpp servers report their per-slot context size in `GET /props`
 * (`default_generation_settings.n_ctx`). That value is the truth for local
 * accounts: it wins over the preset and also feeds auto-compact (profiles.ts
 * `getModelLimits`). Servers without `/props` (Ollama, LM Studio, hosted APIs)
 * just count as online when they answer at all.
 *
 * FNHARNESS_SERVER_PROBE=0 disables the probe.
 */

import { isLocalBaseUrl, speedSummaryToJson, type SpeedSummary } from './speedStats.js'

type Env = Record<string, string | undefined>

export type ContextSource = 'server' | 'preset' | 'catalog' | 'claude' | 'default'

export type ServerInfo = {
  /** Did the server answer (any HTTP status below 500) at the last check. */
  online: boolean
  /** Per-slot context size reported by llama.cpp, when known. */
  nCtx: number | null
  /** Model name reported by the server (file name for llama.cpp), when known. */
  model: string | null
  checkedAt: number
}

export type AccountStatusInput = {
  accountId: string
  accountLabel: string
  /** null for the native Anthropic account. */
  provider: string | null
  baseUrl: string | null
  /** Model id the session sends. */
  model: string
  /** Effective window used for percentages and auto-compact. */
  contextWindow: number
  contextSource: ContextSource
  /** Tokens at which auto-compact fires; null when it is off. */
  autoCompactAt: number | null
  maxOutputTokens: number | null
  server: ServerInfo | null
  speed: SpeedSummary | null
  /** USD per Mtok in/out when the catalog prices the model. */
  pricePerMtok: { input: number; output: number } | null
  /** Perfil de contexto activo (/perfil) y si se modificó a mano; null/ausente = ninguno. */
  profile?: { name: string; modified: boolean } | null
  now: number
}

export type AccountStatusJson = {
  account: {
    id: string
    label: string
    provider: string | null
    base_url: string | null
    local: boolean
    model: string
    /** Name the server itself reports, when it differs from `model` (e.g. llama.cpp "default"). */
    server_model: string | null
  }
  context: {
    window: number
    source: ContextSource
    autocompact_at: number | null
    max_output_tokens: number | null
  }
  server: { online: boolean; n_ctx: number | null; age_s: number } | null
  speed: Record<string, unknown> | null
  /** 'subscription' (claude), 'priced' (catalog price), 'free' (local server), 'unpriced' (no known price). */
  cost: { kind: 'subscription' | 'priced' | 'free' | 'unpriced'; input_per_mtok?: number; output_per_mtok?: number }
  /** Perfil de contexto activo, o null si nadie eligió uno. */
  profile: { name: string; modified: boolean } | null
}

/** Pure: the `fnharness` object the status bar command receives. */
export function buildAccountStatus(i: AccountStatusInput): AccountStatusJson {
  const native = i.provider === null
  const local = isLocalBaseUrl(i.baseUrl ?? undefined)
  const serverModel = i.server?.model && i.server.model !== i.model ? i.server.model : null
  const cost: AccountStatusJson['cost'] = native
    ? { kind: 'subscription' }
    : local
      ? { kind: 'free' }
      : i.pricePerMtok
        ? { kind: 'priced', input_per_mtok: i.pricePerMtok.input, output_per_mtok: i.pricePerMtok.output }
        : { kind: 'unpriced' }
  return {
    account: {
      id: i.accountId,
      label: i.accountLabel,
      provider: i.provider,
      base_url: i.baseUrl,
      local,
      model: i.model,
      server_model: serverModel,
    },
    context: {
      window: i.contextWindow,
      source: i.contextSource,
      autocompact_at: i.autoCompactAt,
      max_output_tokens: i.maxOutputTokens,
    },
    server: i.server
      ? { online: i.server.online, n_ctx: i.server.nCtx, age_s: Math.max(0, Math.round((i.now - i.server.checkedAt) / 1000)) }
      : null,
    speed: i.speed ? speedSummaryToJson(i.speed) : null,
    cost,
    profile: i.profile ? { name: i.profile.name, modified: i.profile.modified } : null,
  }
}

/** Pure: where the effective window came from. */
export function contextSource(args: {
  native: boolean
  serverNCtx: number | null
  presetWindow: number | undefined
  catalogWindow: number | undefined
}): ContextSource {
  if (args.native) return 'claude'
  if (args.serverNCtx) return 'server'
  if (args.presetWindow) return 'preset'
  if (args.catalogWindow) return 'catalog'
  return 'default'
}

/** Pure: server root of an OpenAI-compatible base URL (`http://h:8082/v1` -> `http://h:8082`). */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1(beta)?$/, '')
}

/** Pure: reads the useful fields of a llama.cpp `/props` body. */
export function parseProps(body: unknown): { nCtx: number | null; model: string | null } {
  const b = (body ?? {}) as Record<string, any>
  const n = b.default_generation_settings?.n_ctx ?? b.n_ctx
  const raw = b.model_alias ?? b.model_path
  const model = typeof raw === 'string' && raw ? (raw.split('/').pop() ?? raw).replace(/\.gguf$/i, '') : null
  return { nCtx: typeof n === 'number' && n > 0 ? n : null, model }
}

// --- server info cache (the only state) --------------------------------------

export const ONLINE_TTL_MS = 15_000
export const OFFLINE_TTL_MS = 4_000
const PROBE_TIMEOUT_MS = 800

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>

const cache = new Map<string, ServerInfo>()
const inFlight = new Set<string>()

export function probeEnabled(env: Env = process.env): boolean {
  const v = env.FNHARNESS_SERVER_PROBE
  return !(v === '0' || v === 'false' || v === 'off')
}

/** Cached info for a backend, or null when it was never probed. Never touches the network. */
export function getServerInfo(baseUrl: string | null | undefined): ServerInfo | null {
  return baseUrl ? (cache.get(serverRoot(baseUrl)) ?? null) : null
}

/** Pure: is the cached entry old enough to look again. */
export function isStale(info: ServerInfo | null, now: number): boolean {
  if (!info) return true
  return now - info.checkedAt >= (info.online ? ONLINE_TTL_MS : OFFLINE_TTL_MS)
}

/** One `GET /props`; a network failure means offline, any answer below 500 means online. */
export async function probeServer(baseUrl: string, fetchFn: Fetch = fetch as unknown as Fetch, now = Date.now()): Promise<ServerInfo> {
  try {
    const res = await fetchFn(`${serverRoot(baseUrl)}/props`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (res.status >= 500) return { online: false, nCtx: null, model: null, checkedAt: now }
    if (res.status !== 200) return { online: true, nCtx: null, model: null, checkedAt: now }
    const props = parseProps(await res.json().catch(() => null))
    return { online: true, ...props, checkedAt: now }
  } catch {
    return { online: false, nCtx: null, model: null, checkedAt: now }
  }
}

/**
 * Fire-and-forget refresh: starts one probe when the cache is stale and none is
 * running. Hosted APIs are not probed (no `/props`, and a request per refresh
 * would cost): only local servers, where "does it answer" is the question.
 */
export function refreshServerInfo(baseUrl: string | null | undefined, env: Env = process.env, fetchFn?: Fetch, now = Date.now()): void {
  if (!baseUrl || !probeEnabled(env) || !isLocalBaseUrl(baseUrl)) return
  const root = serverRoot(baseUrl)
  if (inFlight.has(root) || !isStale(cache.get(root) ?? null, now)) return
  inFlight.add(root)
  void probeServer(baseUrl, fetchFn, now)
    .then(info => cache.set(root, info))
    .finally(() => inFlight.delete(root))
}

/** Tests only. */
export function resetServerInfoForTesting(): void {
  cache.clear()
  inFlight.clear()
}

/** Tests only: seed the cache. */
export function setServerInfoForTesting(baseUrl: string, info: ServerInfo): void {
  cache.set(serverRoot(baseUrl), info)
}
