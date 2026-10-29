/**
 * Secret managers for fnharness: where an account's API key lives.
 *
 * A key is addressed by a reference string `<backend>:<ref>` that is stored in
 * `accounts.json` (`apiKeyRef`) instead of the key itself:
 *
 *   env:VENICE_API_KEY     read-only, an environment variable
 *   pass:apis/venice       the `pass` password store (GPG)
 *   file:venice            `<config dir>/secrets.json`, plaintext, mode 0600
 *   keyring:venice         desktop keyring through `secret-tool` (libsecret)
 *   cmd:venice             a user command declared in secrets.json, e.g. `op read op://...`
 *
 * Nothing here prints or logs a value. Every external process goes through the
 * injectable `Runner` so the backends can be tested without pass or a keyring.
 */

import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export type Env = Record<string, string | undefined>

export type RunResult = { status: number | null; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], input?: string) => RunResult

export type Ctx = { env: Env; run: Runner }

export class SecretError extends Error {}

const RUN_TIMEOUT_MS = 8000

export const defaultRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input: input ?? '', encoding: 'utf8', timeout: RUN_TIMEOUT_MS })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') }
}

let activeRunner: Runner = defaultRunner

/** Tests only: route every default context through a fake runner (null = the real one). */
export function setRunnerForTesting(run: Runner | null): void {
  activeRunner = run ?? defaultRunner
  clearSecretCache()
}

export function defaultCtx(env: Env = process.env): Ctx {
  return { env, run: activeRunner }
}

/** First non-empty line, trimmed: `pass show` may carry extra lines after the key. */
function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
}

function secretsFile(env: Env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'secrets.json')
}

type SecretsFile = {
  values: Record<string, string>
  commands: Record<string, { get: string; set?: string; remove?: string }>
}

export function loadSecretsFile(env: Env): SecretsFile {
  try {
    const raw = JSON.parse(readFileSync(secretsFile(env), 'utf8'))
    return { values: raw.values ?? {}, commands: raw.commands ?? {} }
  } catch {
    return { values: {}, commands: {} }
  }
}

function saveSecretsFile(env: Env, data: SecretsFile): void {
  const path = secretsFile(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** pass entries are paths; keep them away from option parsing and from escaping the store. */
function assertPassRef(ref: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@+\-/]*$/.test(ref) || ref.includes('..')) {
    throw new SecretError(`Referencia de pass no válida: "${ref}" (usa algo como apis/venice)`)
  }
}

function assertSimpleRef(ref: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@+\-]*$/.test(ref)) {
    throw new SecretError(`Referencia no válida: "${ref}" (letras, números, . _ - @ +)`)
  }
}

function passStoreDir(env: Env): string {
  return env.PASSWORD_STORE_DIR || join(homedir(), '.password-store')
}

export type Backend = {
  id: string
  label: string
  /** Can /secrets write values here? */
  writable: boolean
  /** One-line explanation of the reference format. */
  refHelp: string
  defaultRef(accountId: string): string
  /** Is the tool there? (no decryption) */
  available(ctx: Ctx): { ok: boolean; hint: string }
  /** Cheap presence check that never decrypts. */
  exists(ref: string, ctx: Ctx): boolean
  get(ref: string, ctx: Ctx): string
  set?(ref: string, value: string, ctx: Ctx): void
  remove?(ref: string, ctx: Ctx): void
}

function tool(ctx: Ctx, cmd: string, args: string[], missingHint: string): { ok: boolean; hint: string } {
  const r = ctx.run(cmd, args)
  return r.status === 0 ? { ok: true, hint: '' } : { ok: false, hint: missingHint }
}

const envBackend: Backend = {
  id: 'env',
  label: 'Variable de entorno',
  writable: false,
  refHelp: 'env:NOMBRE_DE_LA_VARIABLE',
  defaultRef: () => '',
  available: () => ({ ok: true, hint: '' }),
  exists: (ref, ctx) => Boolean(ctx.env[ref]),
  get(ref, ctx) {
    const v = ctx.env[ref]
    if (!v) throw new SecretError(`la variable ${ref} no está definida`)
    return v
  },
}

const passBackend: Backend = {
  id: 'pass',
  label: 'pass (GPG)',
  writable: true,
  refHelp: 'pass:ruta/en/el/store (por ejemplo pass:apis/venice)',
  defaultRef: id => `apis/${id}`,
  available: ctx => tool(ctx, 'pass', ['--version'], 'pass no está instalado'),
  exists(ref, ctx) {
    assertPassRef(ref)
    return existsSync(join(passStoreDir(ctx.env), `${ref}.gpg`))
  },
  get(ref, ctx) {
    assertPassRef(ref)
    const r = ctx.run('pass', ['show', ref])
    if (r.status !== 0) throw new SecretError(`pass show ${ref} falló${r.stderr ? `: ${firstLine(r.stderr)}` : ''}`)
    const v = firstLine(r.stdout)
    if (!v) throw new SecretError(`la entrada ${ref} de pass está vacía`)
    return v
  },
  set(ref, value, ctx) {
    assertPassRef(ref)
    const r = ctx.run('pass', ['insert', '--multiline', '--force', ref], value + '\n')
    if (r.status !== 0) throw new SecretError(`pass insert ${ref} falló${r.stderr ? `: ${firstLine(r.stderr)}` : ''}`)
  },
  remove(ref, ctx) {
    assertPassRef(ref)
    const r = ctx.run('pass', ['rm', '--force', ref])
    if (r.status !== 0) throw new SecretError(`pass rm ${ref} falló${r.stderr ? `: ${firstLine(r.stderr)}` : ''}`)
  },
}

const fileBackend: Backend = {
  id: 'file',
  label: 'Archivo secrets.json (0600, en claro)',
  writable: true,
  refHelp: 'file:nombre',
  defaultRef: id => id,
  available: () => ({ ok: true, hint: '' }),
  exists: (ref, ctx) => Boolean(loadSecretsFile(ctx.env).values[ref]),
  get(ref, ctx) {
    assertSimpleRef(ref)
    const v = loadSecretsFile(ctx.env).values[ref]
    if (!v) throw new SecretError(`no hay valor "${ref}" en ${secretsFile(ctx.env)}`)
    return v
  },
  set(ref, value, ctx) {
    assertSimpleRef(ref)
    const data = loadSecretsFile(ctx.env)
    data.values[ref] = value
    saveSecretsFile(ctx.env, data)
  },
  remove(ref, ctx) {
    const data = loadSecretsFile(ctx.env)
    delete data.values[ref]
    saveSecretsFile(ctx.env, data)
  },
}

const keyringBackend: Backend = {
  id: 'keyring',
  label: 'Llavero del escritorio (secret-tool)',
  writable: true,
  refHelp: 'keyring:nombre',
  defaultRef: id => id,
  available: ctx => tool(ctx, 'secret-tool', ['--version'], 'instala libsecret-tools (secret-tool)'),
  exists(ref, ctx) {
    assertSimpleRef(ref)
    return ctx.run('secret-tool', ['lookup', 'service', 'fnharness', 'account', ref]).stdout.trim() !== ''
  },
  get(ref, ctx) {
    assertSimpleRef(ref)
    const r = ctx.run('secret-tool', ['lookup', 'service', 'fnharness', 'account', ref])
    const v = r.stdout.trim()
    if (r.status !== 0 || !v) throw new SecretError(`no hay "${ref}" en el llavero (service=fnharness)`)
    return v
  },
  set(ref, value, ctx) {
    assertSimpleRef(ref)
    const r = ctx.run('secret-tool', ['store', `--label=fnharness:${ref}`, 'service', 'fnharness', 'account', ref], value)
    if (r.status !== 0) throw new SecretError(`secret-tool store falló${r.stderr ? `: ${firstLine(r.stderr)}` : ''}`)
  },
  remove(ref, ctx) {
    assertSimpleRef(ref)
    ctx.run('secret-tool', ['clear', 'service', 'fnharness', 'account', ref])
  },
}

const cmdBackend: Backend = {
  id: 'cmd',
  label: 'Comando propio (op, bw, vault...)',
  writable: false,
  refHelp: 'cmd:nombre, definido en secrets.json → "commands": {"nombre": {"get": "op read op://..."}}',
  defaultRef: id => id,
  available: () => ({ ok: true, hint: '' }),
  exists: (ref, ctx) => Boolean(loadSecretsFile(ctx.env).commands[ref]?.get),
  get(ref, ctx) {
    assertSimpleRef(ref)
    const def = loadSecretsFile(ctx.env).commands[ref]
    if (!def?.get) throw new SecretError(`no hay comando "${ref}" en ${secretsFile(ctx.env)} (commands.${ref}.get)`)
    const r = ctx.run('sh', ['-c', def.get])
    const v = firstLine(r.stdout)
    if (r.status !== 0 || !v) throw new SecretError(`el comando de "${ref}" falló${r.stderr ? `: ${firstLine(r.stderr)}` : ''}`)
    return v
  },
}

export const BACKENDS: Record<string, Backend> = {
  pass: passBackend,
  env: envBackend,
  file: fileBackend,
  keyring: keyringBackend,
  cmd: cmdBackend,
}

export type SecretRef = { backend: Backend; ref: string }

/** `pass:apis/venice` → backend + ref. Throws SecretError on unknown backends or an empty ref. */
export function parseRef(text: string): SecretRef {
  const i = text.indexOf(':')
  const id = i < 0 ? '' : text.slice(0, i)
  const backend = BACKENDS[id]
  if (!backend) {
    throw new SecretError(`Referencia "${text}" no válida: usa <gestor>:<ref> con gestor en ${Object.keys(BACKENDS).join(', ')}`)
  }
  const ref = text.slice(i + 1).trim()
  if (!ref) throw new SecretError(`Falta la referencia tras "${id}:" (${backend.refHelp})`)
  return { backend, ref }
}

export function formatRef(backendId: string, ref: string): string {
  return `${backendId}:${ref}`
}

const cache = new Map<string, string>()

/** Forget every resolved value (after /secrets changes something). */
export function clearSecretCache(): void {
  cache.clear()
}

/** Resolves a reference to its value; each reference is read from its backend once per process. */
export function resolveRef(text: string, ctx: Ctx = defaultCtx()): string {
  const hit = cache.get(text)
  if (hit) return hit
  const { backend, ref } = parseRef(text)
  const value = backend.get(ref, ctx)
  cache.set(text, value)
  return value
}

export type SecretState = 'ok' | 'missing' | 'unavailable'

/** Presence of a reference without decrypting anything (pass: file exists; keyring: lookup). */
export function refState(text: string, ctx: Ctx = defaultCtx()): { state: SecretState; detail: string } {
  let parsed: SecretRef
  try {
    parsed = parseRef(text)
  } catch (err) {
    return { state: 'missing', detail: (err as Error).message }
  }
  const avail = parsed.backend.available(ctx)
  if (!avail.ok) return { state: 'unavailable', detail: avail.hint }
  try {
    return parsed.backend.exists(parsed.ref, ctx)
      ? { state: 'ok', detail: '' }
      : { state: 'missing', detail: `no existe ${text}` }
  } catch (err) {
    return { state: 'missing', detail: (err as Error).message }
  }
}

/** Writes `value` at `<backend>:<ref>` and returns the reference string. */
export function storeSecret(backendId: string, ref: string, value: string, ctx: Ctx = defaultCtx()): string {
  const backend = BACKENDS[backendId]
  if (!backend) throw new SecretError(`Gestor desconocido "${backendId}" (${Object.keys(BACKENDS).join(', ')})`)
  if (!backend.writable || !backend.set) {
    throw new SecretError(`${backend.id} no admite escribir desde /secrets: ${backend.refHelp}. Usa /secrets use <cuenta> ${backend.id}:<ref>.`)
  }
  const avail = backend.available(ctx)
  if (!avail.ok) throw new SecretError(`${backend.id} no disponible: ${avail.hint}`)
  backend.set(ref, value, ctx)
  clearSecretCache()
  return formatRef(backend.id, ref)
}

/** Deletes the stored value behind a reference (no-op for read-only backends). */
export function purgeSecret(text: string, ctx: Ctx = defaultCtx()): boolean {
  const { backend, ref } = parseRef(text)
  clearSecretCache()
  if (!backend.writable || !backend.remove) return false
  backend.remove(ref, ctx)
  return true
}
