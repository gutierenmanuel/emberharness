/**
 * Side-effecting actions behind /account. Kept out of the JSX file so the
 * command's behaviour can be tested without rendering anything.
 */

import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  isLocalUrl,
  listAccounts,
  loadStore,
  probeBackend,
  profileForAccount,
  saveStore,
  type Account,
} from '../../services/api/openai-compat/accounts.js'
import {
  MultimodelConfigError,
  PROVIDER_PRESETS,
  getMultimodelProfile,
  setActiveProfile,
} from '../../services/api/openai-compat/profiles.js'

export type ActionResult = {
  message: string
  /** Set when the session's model must change (null = harness default). */
  model?: string | null
}

export function activeAccountId(env = process.env): string {
  return env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
}

/** Accounts plus, for local backends, whether the server answers right now. */
export async function accountsWithStatus(
  env = process.env,
): Promise<Array<Account & { online?: boolean }>> {
  const accounts = listAccounts(loadStore(accountsFilePath(env)), env)
  return Promise.all(
    accounts.map(async a =>
      a.ready && isLocalUrl(a.baseUrl)
        ? { ...a, online: await probeBackend(a.baseUrl!) }
        : a,
    ),
  )
}

export function formatAccountLine(
  a: Account & { online?: boolean },
  activeId: string,
): string {
  const mark = a.id === activeId ? '●' : ' '
  const state = !a.ready ? '✗' : a.online === false ? '○ apagado' : '✓'
  return `${mark} ${a.id.padEnd(11)} ${state.padEnd(9)} ${a.label} — ${a.detail}`
}

export function switchAccount(
  id: string,
  model: string | undefined,
  env = process.env,
): ActionResult {
  const path = accountsFilePath(env)
  const store = loadStore(path)
  if (model && id !== CLAUDE_ACCOUNT_ID) {
    store.accounts[id] = { ...store.accounts[id], model }
  }
  const profile = profileForAccount(id, store, env)
  setActiveProfile(profile, id, env)
  saveStore({ ...store, active: id }, path)

  return profile
    ? {
        message: `Cuenta activa: ${profile.label} (${id}) · modelo ${profile.model} · ${profile.baseUrl}`,
        model: profile.model,
      }
    : {
        message:
          'Cuenta activa: Claude (Anthropic). Si no has iniciado sesión en fnharness, usa /login.',
        model: null,
      }
}

export function setKey(id: string, apiKey: string, env = process.env): ActionResult {
  if (!(id in PROVIDER_PRESETS) && !loadStore(accountsFilePath(env)).accounts[id]) {
    throw new MultimodelConfigError(`Unknown account "${id}"`)
  }
  const path = accountsFilePath(env)
  const store = loadStore(path)
  store.accounts[id] = { ...store.accounts[id], apiKey }
  saveStore(store, path)
  return { message: `Clave guardada para ${id} en ${path} (modo 0600).` }
}

export function addAccount(
  id: string,
  baseUrl: string,
  model: string | undefined,
  env = process.env,
): ActionResult {
  if (id === CLAUDE_ACCOUNT_ID || id in PROVIDER_PRESETS) {
    throw new MultimodelConfigError(`"${id}" is a built-in account name`)
  }
  const path = accountsFilePath(env)
  const store = loadStore(path)
  store.accounts[id] = { provider: 'custom', baseUrl, model, label: id }
  saveStore(store, path)
  return { message: `Cuenta ${id} añadida (${baseUrl}). Actívala con /account ${id}.` }
}

export function removeAccount(id: string, env = process.env): ActionResult {
  const path = accountsFilePath(env)
  const store = loadStore(path)
  if (!(id in store.accounts)) {
    return { message: `No hay datos guardados para ${id}.` }
  }
  delete store.accounts[id]
  if (store.active === id) store.active = CLAUDE_ACCOUNT_ID
  saveStore(store, path)
  return { message: `Datos de ${id} eliminados.` }
}

export function currentSummary(): string {
  const p = getMultimodelProfile()
  return p ? `${p.label} · ${p.model}` : 'Claude (Anthropic)'
}
