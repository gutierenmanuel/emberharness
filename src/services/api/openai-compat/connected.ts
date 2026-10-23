/**
 * "N cuentas conectadas · M modelos" counters for the header.
 *
 * Connected = the same rule as the check mark of /account: the account is
 * ready (key present) and, when it is a local server, it answers right now.
 * The probe uses a short timeout so it never slows anything down.
 *
 * The mock lab can override either number by setting
 * `globalThis.__FNHARNESS_MOCKS__ = { accounts?: number, models?: number }`.
 */

import {
  accountsFilePath,
  isLocalUrl,
  listAccounts,
  loadStore,
  probeBackend,
  type Account,
  type AccountStore,
} from './accounts.js'
import { countModels, type ListDeps } from './accountModels.js'

type Env = Record<string, string | undefined>

export type ConnectedSummary = { accounts: number; models: number }

export const PROBE_TIMEOUT_MS = 300

declare global {
  // eslint-disable-next-line no-var
  var __FNHARNESS_MOCKS__: { accounts?: number; models?: number } | undefined
}

/** Pure: the /account check-mark rule. `online` is the probe result for local servers. */
export function isAccountConnected(a: Pick<Account, 'ready' | 'baseUrl'>, online?: boolean): boolean {
  if (!a.ready) return false
  return isLocalUrl(a.baseUrl) ? online === true : true
}

/** Pure: applies the optional mock override over a (possibly still unknown) summary. */
export function applyMockOverride(
  summary: ConnectedSummary | null,
  mocks = globalThis.__FNHARNESS_MOCKS__,
): ConnectedSummary | null {
  const a = mocks?.accounts
  const m = mocks?.models
  if (a === undefined && m === undefined) return summary
  if (a !== undefined && m !== undefined) return { accounts: a, models: m }
  return summary ? { accounts: a ?? summary.accounts, models: m ?? summary.models } : null
}

/** Pure: header text; `null` (still probing) shows an ellipsis. */
export function formatConnectedLine(s: ConnectedSummary | null): string {
  if (!s) return '… cuentas conectadas · … modelos'
  return `${s.accounts} ${s.accounts === 1 ? 'cuenta conectada' : 'cuentas conectadas'} · ${s.models} ${s.models === 1 ? 'modelo' : 'modelos'}`
}

export type SummaryDeps = ListDeps & {
  probe?: (baseUrl: string, timeoutMs: number) => Promise<boolean>
  store?: AccountStore
}

/** Ids of the connected accounts. Local servers are probed in parallel. */
export async function connectedAccountIds(env: Env, deps: SummaryDeps = {}): Promise<string[]> {
  const store = deps.store ?? loadStore(accountsFilePath(env))
  const probe = deps.probe ?? probeBackend
  const accounts = listAccounts(store, env)
  const flags = await Promise.all(
    accounts.map(async a => {
      if (!a.ready) return false
      return isAccountConnected(a, isLocalUrl(a.baseUrl) ? await probe(a.baseUrl!, PROBE_TIMEOUT_MS) : undefined)
    }),
  )
  return accounts.filter((_, i) => flags[i]).map(a => a.id)
}

/** Counts connected accounts and the models they offer (no hosted /models calls). */
export async function computeConnectedSummary(env: Env = process.env, deps: SummaryDeps = {}): Promise<ConnectedSummary> {
  const store = deps.store ?? loadStore(accountsFilePath(env))
  const ids = await connectedAccountIds(env, { ...deps, store })
  const models = await countModels(ids, store, env, { ...deps, remote: false })
  return { accounts: ids.length, models }
}
