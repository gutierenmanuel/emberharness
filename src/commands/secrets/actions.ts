/**
 * Side-effecting actions behind /secrets. Kept out of the JSX file so the
 * behaviour can be tested without rendering. No function here returns or
 * prints a key: messages only name accounts, gestores and references.
 */

import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  isKnownAccount,
  isLocalUrl,
  listAccounts,
  loadStore,
  providerKeyEnv,
  saveStore,
  profileForAccount,
  type AccountStore,
} from '../../services/api/openai-compat/accounts.js'
import { MultimodelConfigError } from '../../services/api/openai-compat/profiles.js'
import {
  BACKENDS,
  SecretError,
  clearSecretCache,
  defaultCtx,
  formatRef,
  parseRef,
  purgeSecret,
  refState,
  resolveRef,
  storeSecret,
  type Ctx,
  type SecretState,
} from '../../services/secrets/secrets.js'

export type ActionResult = { message: string }

export type SecretSource = 'env' | 'ref' | 'legacy' | 'none'

export type SecretRow = {
  id: string
  label: string
  source: SecretSource
  /** `<gestor>:<ref>` when the account points at a secret manager. */
  ref?: string
  /** Provider variable (VENICE_API_KEY) when known. */
  envName?: string
  state: SecretState
  detail: string
}

const paths = (env: Record<string, string | undefined>) => accountsFilePath(env)

function requireAccount(store: AccountStore, id: string): void {
  if (id === CLAUDE_ACCOUNT_ID) throw new MultimodelConfigError('claude usa /login, no una API key')
  if (!isKnownAccount(id, store)) throw new MultimodelConfigError(`Cuenta desconocida "${id}". Mira /account list.`)
}

/**
 * Pure-ish: one row per account that needs a key (hosted backends, plus any
 * local one that already has a stored key or reference). The precedence shown
 * matches what the harness does at startup: literal key in accounts.json, then
 * the exported provider variable, then the reference.
 */
export function secretRows(env: Record<string, string | undefined> = process.env, ctx: Ctx = defaultCtx(env)): SecretRow[] {
  const store = loadStore(paths(env))
  const rows: SecretRow[] = []
  for (const a of listAccounts(store, env)) {
    if (a.id === CLAUDE_ACCOUNT_ID) continue
    const stored = store.accounts[a.id]
    const hasStored = Boolean(stored?.apiKey || stored?.apiKeyRef)
    const baseUrl = stored?.baseUrl ?? a.baseUrl
    if (isLocalUrl(baseUrl) && !hasStored) continue
    const provider = stored?.provider ?? a.id
    const envName = providerKeyEnv(provider, env)
    const row = { id: a.id, label: a.label, envName } as SecretRow
    if (stored?.apiKey) {
      Object.assign(row, { source: 'legacy', state: 'ok', detail: 'clave en claro en accounts.json: muévela a un gestor' })
    } else if (envName && env[envName]) {
      Object.assign(row, { source: 'env', ref: stored?.apiKeyRef, state: 'ok', detail: stored?.apiKeyRef ? `${envName} anula ${stored.apiKeyRef}` : envName })
    } else if (stored?.apiKeyRef) {
      Object.assign(row, { source: 'ref', ref: stored.apiKeyRef, ...refState(stored.apiKeyRef, ctx) })
    } else {
      Object.assign(row, { source: 'none', state: 'missing', detail: envName ? `sin clave (${envName} o /secrets set ${a.id} <gestor>)` : `sin clave (/secrets set ${a.id} <gestor>)` })
    }
    rows.push(row)
  }
  return rows
}

export function formatRow(r: SecretRow): string {
  const mark = r.state === 'ok' ? '✓' : r.state === 'unavailable' ? '!' : '✗'
  const where = r.source === 'env' ? `env:${r.envName}` : r.source === 'legacy' ? 'accounts.json (en claro)' : (r.ref ?? '—')
  return `${mark} ${r.id.padEnd(14)} ${where.padEnd(28)} ${r.detail}`.trimEnd()
}

/** The value currently used by an account, ignoring the env override (what a move would carry). */
function currentValue(store: AccountStore, id: string, ctx: Ctx): string {
  const stored = store.accounts[id]
  if (stored?.apiKey) return stored.apiKey
  if (stored?.apiKeyRef) return resolveRef(stored.apiKeyRef, ctx)
  throw new SecretError(`${id} no tiene clave guardada que mover`)
}

function saveRef(store: AccountStore, env: Record<string, string | undefined>, id: string, ref: string | undefined): void {
  const { apiKey: _legacy, apiKeyRef: _old, ...rest } = store.accounts[id] ?? {}
  store.accounts[id] = ref ? { ...rest, apiKeyRef: ref } : rest
  saveStore(store, paths(env))
  clearSecretCache()
}

/** Writes `value` into `backendId` (ref defaults per gestor) and points the account at it. */
export function setSecret(
  id: string,
  backendId: string,
  value: string,
  refArg?: string,
  env: Record<string, string | undefined> = process.env,
  ctx: Ctx = defaultCtx(env),
): ActionResult {
  const store = loadStore(paths(env))
  requireAccount(store, id)
  const backend = BACKENDS[backendId]
  if (!backend) throw new SecretError(`Gestor desconocido "${backendId}" (${Object.keys(BACKENDS).join(', ')})`)
  const ref = storeSecret(backendId, refArg ?? backend.defaultRef(id), value, ctx)
  saveRef(store, env, id, ref)
  return { message: `Clave de ${id} guardada en ${ref}. Ya no hace falta ninguna en accounts.json.` }
}

/** Points the account at a secret that already exists (e.g. `pass:apis/venice`). */
export function useSecret(
  id: string,
  refText: string,
  env: Record<string, string | undefined> = process.env,
  ctx: Ctx = defaultCtx(env),
): ActionResult {
  const store = loadStore(paths(env))
  requireAccount(store, id)
  const { backend, ref } = parseRef(refText)
  const avail = backend.available(ctx)
  if (!avail.ok) throw new SecretError(`${backend.id} no disponible: ${avail.hint}`)
  const text = formatRef(backend.id, ref)
  // Fail now (typo, locked store) instead of at the next launch.
  backend.get(ref, ctx)
  saveRef(store, env, id, text)
  return { message: `${id} usa ahora ${text} (leída con éxito).` }
}

/** Moves the key of an account to another gestor; the old copy is deleted when its gestor allows it. */
export function moveSecret(
  id: string,
  toBackend: string,
  toRef: string | undefined,
  env: Record<string, string | undefined> = process.env,
  ctx: Ctx = defaultCtx(env),
): ActionResult {
  const store = loadStore(paths(env))
  requireAccount(store, id)
  const backend = BACKENDS[toBackend]
  if (!backend) throw new SecretError(`Gestor desconocido "${toBackend}" (${Object.keys(BACKENDS).join(', ')})`)
  const oldRef = store.accounts[id]?.apiKeyRef
  const legacy = Boolean(store.accounts[id]?.apiKey)
  const value = currentValue(store, id, ctx)
  const ref = storeSecret(toBackend, toRef ?? backend.defaultRef(id), value, ctx)
  saveRef(store, env, id, ref)
  let tail = legacy ? ' (retirada de accounts.json)' : ''
  if (oldRef && oldRef !== ref) {
    try {
      tail = purgeSecret(oldRef, ctx) ? ` (borrada la copia de ${oldRef})` : ` (${oldRef} se deja como estaba: solo lectura)`
    } catch (err) {
      tail = ` (no se pudo borrar ${oldRef}: ${(err as Error).message})`
    }
  }
  return { message: `Clave de ${id} movida a ${ref}${tail}.` }
}

/** Unlinks the account from its key; with `purge` the stored value is deleted from the gestor too. */
export function removeSecret(
  id: string,
  purge: boolean,
  env: Record<string, string | undefined> = process.env,
  ctx: Ctx = defaultCtx(env),
): ActionResult {
  const store = loadStore(paths(env))
  const stored = store.accounts[id]
  if (!stored?.apiKey && !stored?.apiKeyRef) return { message: `${id} no tiene clave guardada por fnharness.` }
  const ref = stored.apiKeyRef
  let tail = ''
  if (purge && ref) {
    tail = purgeSecret(ref, ctx) ? ` y borrado el valor de ${ref}` : ` (${ref} es de solo lectura: el valor no se toca)`
  }
  saveRef(store, env, id, undefined)
  return { message: `${id} desvinculada de su clave${tail}.` }
}

/** Resolves the key as the harness would and, when the account is hosted, checks it against GET {baseUrl}/models. */
export async function testSecret(
  id: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ActionResult> {
  const store = loadStore(paths(env))
  requireAccount(store, id)
  clearSecretCache()
  const profile = profileForAccount(id, store, env)
  if (!profile) return { message: 'claude usa /login.' }
  if (!profile.apiKey) return { message: `${id} no necesita clave (servidor local).` }
  try {
    const res = await fetchImpl(`${profile.baseUrl}/models`, {
      headers: { authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    return {
      message: res.ok
        ? `${id}: clave leída (${profile.apiKey.length} caracteres) y aceptada por ${profile.baseUrl} (HTTP ${res.status}).`
        : `${id}: clave leída (${profile.apiKey.length} caracteres) pero ${profile.baseUrl} responde HTTP ${res.status}.`,
    }
  } catch (err) {
    return { message: `${id}: clave leída (${profile.apiKey.length} caracteres); no se pudo contactar ${profile.baseUrl}: ${(err as Error).message}` }
  }
}

/** Lines for `/secrets backends`: what is installed and how a reference looks. */
export function backendLines(ctx: Ctx = defaultCtx()): string[] {
  return Object.values(BACKENDS).map(b => {
    const a = b.available(ctx)
    return `${a.ok ? '✓' : '✗'} ${b.id.padEnd(8)} ${b.label}${b.writable ? '' : ' [solo lectura]'} — ${a.ok ? b.refHelp : a.hint}`
  })
}
