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
import { findProvider, usableProviders, type Catalog } from '../../services/api/openai-compat/catalog.js'
import { loadCatalog } from '../../services/api/openai-compat/catalogStore.js'
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

/**
 * Persists a model picked with /model for the active account, exactly like
 * `/account <id> <modelo>`. No-op on the Claude account.
 */
export function persistModelForActiveAccount(model: string | null, env = process.env): void {
  const id = activeAccountId(env)
  if (!model || id === CLAUDE_ACCOUNT_ID) return
  try {
    switchAccount(id, model, env)
  } catch {
    // Keep the in-session choice even if the account file cannot be written.
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

/**
 * `add <id> <baseUrl> [modelo]` creates a custom OpenAI-compatible account;
 * `add <proveedor-del-catalogo> [id] [modelo]` creates one from the models.dev
 * catalog without asking for the URL.
 */
export function addAccount(
  first: string,
  second: string | undefined,
  third: string | undefined,
  env = process.env,
  catalog: Catalog = loadCatalog(),
): ActionResult {
  if (second && /^https?:\/\//.test(second)) return addCustomAccount(first, second, third, env)

  const provider = findProvider(catalog, first)
  if (!provider) {
    throw new MultimodelConfigError(
      `"${first}" no está en el catálogo (mira /account catalog) y no es una URL: usa /account add <id> <baseUrl> [modelo]`,
    )
  }
  if (provider.kind !== 'openai' || !provider.baseUrl) {
    const why = provider.kind === 'anthropic' ? 'habla el protocolo de Anthropic' : 'usa un SDK o credenciales propias'
    throw new MultimodelConfigError(`${provider.name} (${provider.id}) ${why}; fnharness aún solo sabe hablar OpenAI-compatible.`)
  }
  if (first in PROVIDER_PRESETS) {
    throw new MultimodelConfigError(`"${first}" ya es una cuenta integrada: actívala con /account ${first}.`)
  }
  const id = second ?? provider.id
  if (id === CLAUDE_ACCOUNT_ID || id in PROVIDER_PRESETS) {
    throw new MultimodelConfigError(`"${id}" is a built-in account name`)
  }
  const path = accountsFilePath(env)
  const store = loadStore(path)
  store.accounts[id] = { provider: provider.id, label: provider.name, model: third }
  saveStore(store, path)
  const keyHint = provider.env[0] ? `Pon la clave con /account key ${id} <apikey> o ${provider.env[0]}.` : ''
  return {
    message: `Cuenta ${id} añadida (${provider.name}, ${provider.baseUrl}, ${provider.models.length} modelos). ${keyHint} Actívala con /account ${id}.`,
  }
}

function addCustomAccount(
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

/** Pure: lines for `/account catalog [texto]`. */
export function catalogLines(catalog: Catalog, filter = ''): string[] {
  const q = filter.trim().toLowerCase()
  const match = (p: { id: string; name: string }) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  const usable = usableProviders(catalog).filter(match)
  const others = Object.values(catalog).filter(p => !usable.includes(p) && match(p) && !(p.kind === 'openai' && p.baseUrl))
  const lines = usable.map(
    p => `${p.id.padEnd(24)} ${String(p.models.length).padStart(4)} modelos  ${p.name}${p.id in PROVIDER_PRESETS ? '  (cuenta integrada)' : ''}`,
  )
  lines.unshift(`Catálogo models.dev: ${usable.length} proveedores OpenAI-compatibles. Alta: /account add <proveedor> [id] [modelo]`)
  if (others.length) lines.push(`(${others.length} más con otro protocolo, no usables aún${q ? '' : '; filtra con /account catalog <texto>'})`)
  return lines
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

/** One row of the interactive /account picker. */
export type PickerEntry =
  | { kind: 'account'; id: string; label: string; detail: string; ready: boolean; online?: boolean }
  | { kind: 'preset'; id: string; label: string; keyEnv?: string }
  | { kind: 'catalog'; id: string; label: string; modelCount: number; keyEnv?: string }

export type PickerSections = { active: PickerEntry[]; add: PickerEntry[] }

/**
 * Pure: splits accounts + catalog into the two picker sections.
 *  - active: Claude, ready presets, saved accounts (also those still missing a key) and local servers.
 *  - add: built-in presets that still lack a key, then catalog providers not yet saved
 *    (most models first, ties alphabetical). `query` filters the add section by id or name.
 */
export function buildPickerSections(
  accounts: Array<Account & { online?: boolean }>,
  catalog: Catalog,
  query = '',
  stored: Record<string, unknown> = {},
): PickerSections {
  const q = query.trim().toLowerCase()
  const match = (id: string, name: string) => !q || id.toLowerCase().includes(q) || name.toLowerCase().includes(q)

  const active: PickerEntry[] = []
  const add: PickerEntry[] = []
  for (const a of accounts) {
    if (a.ready || !(a.id in PROVIDER_PRESETS)) {
      active.push({ kind: 'account', id: a.id, label: a.label, detail: a.detail, ready: a.ready, online: a.online })
    } else if (match(a.id, a.label)) {
      add.push({ kind: 'preset', id: a.id, label: a.label, keyEnv: PROVIDER_PRESETS[a.id]?.apiKeyEnv })
    }
  }
  const taken = new Set(accounts.map(a => a.id))
  for (const id of Object.keys(stored)) taken.add(id)
  for (const p of usableProviders(catalog)) {
    if (taken.has(p.id) || p.id in PROVIDER_PRESETS || !match(p.id, p.name)) continue
    add.push({ kind: 'catalog', id: p.id, label: p.name, modelCount: p.models.length, keyEnv: p.env[0] })
  }
  return { active, add }
}

/** Env/key hint shown after picking a preset that has no key yet. */
export function presetKeyHint(id: string): string {
  const env = PROVIDER_PRESETS[id]?.apiKeyEnv
  return `${PROVIDER_PRESETS[id]?.label ?? id} necesita clave: /account key ${id} <apikey>${env ? ` o la variable ${env}` : ''}.`
}
