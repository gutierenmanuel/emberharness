/**
 * Lectura y escritura de perfiles de contexto (ver perfil.ts).
 *
 *   fábrica   src/config/defaults/perfiles/*.json  (versionados con el arnés)
 *   usuario   <CLAUDE_CONFIG_DIR>/profiles/<nombre>.json  (sustituye al de fábrica del mismo nombre)
 *   estado    <CLAUDE_CONFIG_DIR>/profiles.json = { default, active }  (0600)
 *
 * Solo importa fs, path y ficheros ligeros: se usa desde el arranque (cli.tsx) antes
 * de cargar nada más. Lo que necesita la sesión viva (limpiar cachés) está en
 * perfilRuntime.ts.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { configFilePath } from '../services/config/hotJson.js'
import fullJson from '../config/defaults/perfiles/full.json'
import minimoJson from '../config/defaults/perfiles/minimo.json'
import simpleJson from '../config/defaults/perfiles/simple.json'
import {
  PERFIL_NAME_RE,
  parsePerfil,
  perfilToJson,
  mergePerfiles,
  toStartupPatch,
  type Perfil,
} from './perfil.js'

type Env = Record<string, string | undefined>

/** Perfil de partida de la fábrica: lo que hay cuando nadie eligió uno. */
export const FACTORY_DEFAULT_PERFIL = 'full'

const FACTORY_RAW: ReadonlyArray<[string, unknown]> = [
  ['full', fullJson],
  ['simple', simpleJson],
  ['minimo', minimoJson],
]

export type PerfilEntry = { perfil: Perfil; source: 'fábrica' | 'usuario' }

export type PerfilList = {
  entries: PerfilEntry[]
  /** Ficheros de usuario que no se pudieron leer o validar. */
  problems: string[]
  warnings: string[]
}

export function perfilesDir(env: Env = process.env): string {
  return configFilePath('profiles', env)
}

export function perfilStatePath(env: Env = process.env): string {
  return configFilePath('profiles.json', env)
}

export function perfilFilePath(name: string, env: Env = process.env): string {
  return join(perfilesDir(env), `${name}.json`)
}

/** Rellena `systemPrompt.text` leyendo `file` (relativo a profiles/) si solo hay fichero. */
function withPromptFile(p: Perfil, dir: string): Perfil {
  const sp = p.systemPrompt
  if (sp.mode === 'default' || sp.text !== undefined || !sp.file) return p
  const path = resolve(dir, sp.file)
  return { ...p, systemPrompt: { ...sp, text: readFileSync(path, 'utf8').trim() } }
}

function loadFactory(): { perfiles: Record<string, Perfil>; problems: string[] } {
  const perfiles: Record<string, Perfil> = {}
  const problems: string[] = []
  for (const [name, raw] of FACTORY_RAW) {
    const r = parsePerfil(raw, name)
    if (r.ok) perfiles[name] = r.perfil
    else problems.push(r.error)
  }
  return { perfiles, problems }
}

/** Fábrica + usuario, en orden: primero los de fábrica, luego los del usuario por nombre. */
export function listPerfiles(env: Env = process.env): PerfilList {
  const factory = loadFactory()
  const problems = [...factory.problems]
  const warnings: string[] = []
  const user: Record<string, Perfil> = {}
  const dir = perfilesDir(env)
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  } catch {
    // Sin directorio de usuario: solo la fábrica.
  }
  for (const f of files) {
    const name = f.slice(0, -'.json'.length)
    try {
      const r = parsePerfil(JSON.parse(readFileSync(join(dir, f), 'utf8')), name)
      if (!r.ok) {
        problems.push(`${f}: ${r.error}`)
        continue
      }
      user[name] = withPromptFile(r.perfil, dir)
      for (const w of r.warnings) warnings.push(`${name}: ${w}`)
    } catch (err) {
      problems.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const merged = mergePerfiles(factory.perfiles, user)
  const order = [...Object.keys(factory.perfiles), ...Object.keys(user).filter(n => !(n in factory.perfiles))]
  return {
    entries: order.map(n => ({ perfil: merged[n]!, source: n in user ? ('usuario' as const) : ('fábrica' as const) })),
    problems,
    warnings,
  }
}

export function getPerfil(name: string, env: Env = process.env): PerfilEntry | undefined {
  return listPerfiles(env).entries.find(e => e.perfil.name === name)
}

export type PerfilState = { default?: string; active?: string }

export function loadPerfilState(env: Env = process.env): PerfilState {
  try {
    const raw = JSON.parse(readFileSync(perfilStatePath(env), 'utf8')) as Record<string, unknown>
    return {
      ...(typeof raw.default === 'string' && raw.default ? { default: raw.default } : {}),
      ...(typeof raw.active === 'string' && raw.active ? { active: raw.active } : {}),
    }
  } catch {
    return {}
  }
}

export function savePerfilState(state: PerfilState, env: Env = process.env): void {
  const path = perfilStatePath(env)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch {
    // La sesión sigue con el perfil elegido aunque no se pueda recordar.
  }
}

/** Escribe `<profiles>/<name>.json` a partir de `current`; no pisa un fichero existente. */
export function createPerfilFrom(current: Perfil, name: string, env: Env = process.env): string {
  if (!PERFIL_NAME_RE.test(name)) throw new Error(`Nombre de perfil no válido: "${name}"`)
  const path = perfilFilePath(name, env)
  if (existsSync(path)) throw new Error(`Ya existe ${path}; elige otro nombre o edítalo a mano.`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(perfilToJson({ ...current, name }), null, 2) + '\n')
  return path
}

export type PerfilSource = 'cli' | 'env' | 'default' | 'active'

export type ActivePerfil = {
  name: string
  def: Perfil
  /** Si se tocó el scope a mano (/scope, Ctrl+Tab) después de aplicarlo. */
  modified: boolean
  source?: PerfilSource
}

export type ResolvedPerfil =
  | { kind: 'none' }
  | { kind: 'found'; perfil: Perfil; source: PerfilSource }
  | { kind: 'error'; message: string }

/**
 * Perfil con el que arranca la sesión: --perfil > FNHARNESS_PROFILE > default > active.
 * Sin ninguno de los cuatro no hay perfil (`none`) y manda el scope guardado por cuenta;
 * `full` es solo el punto de partida de fábrica, no se impone. Un nombre explícito
 * (--perfil, variable) que no existe es un error; uno recordado que ya no existe se salta.
 */
export function resolveInitialPerfil(cliName: string | undefined, env: Env = process.env): ResolvedPerfil {
  const list = listPerfiles(env)
  const find = (n: string) => list.entries.find(e => e.perfil.name === n)?.perfil
  const missing = (n: string) =>
    `Perfil desconocido "${n}". Disponibles: ${list.entries.map(e => e.perfil.name).join(', ')}`
  if (cliName) {
    const p = find(cliName)
    return p ? { kind: 'found', perfil: p, source: 'cli' } : { kind: 'error', message: missing(cliName) }
  }
  if (env.FNHARNESS_PROFILE) {
    const p = find(env.FNHARNESS_PROFILE)
    return p ? { kind: 'found', perfil: p, source: 'env' } : { kind: 'error', message: missing(env.FNHARNESS_PROFILE) }
  }
  const state = loadPerfilState(env)
  for (const [n, source] of [[state.default, 'default'], [state.active, 'active']] as const) {
    const p = n ? find(n) : undefined
    if (p) return { kind: 'found', perfil: p, source }
  }
  return { kind: 'none' }
}

/** `--perfil x` o `--perfil=x` en un argv. */
export function perfilNameFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--perfil') return argv[i + 1]
    if (a.startsWith('--perfil=')) return a.slice('--perfil='.length)
  }
  return undefined
}

// Variables de entorno que un perfil enciende o apaga. Se recuerda su valor original
// (el que trajo la persona) para restaurarlo al pasar a un perfil que no las toca.
const PERFIL_ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'FNHARNESS_PERFIL_NO_HOOKS',
] as const
const envOriginals = new WeakMap<object, Map<string, string | undefined>>()

/**
 * Fija en `env` lo que el perfil apaga (CLAUDE.md, memoria, hooks) y restaura lo demás.
 * Es lo que hace caliente el cambio de perfil; bare no se toca aquí (solo al arrancar).
 */
export function applyPerfilEnv(p: Perfil, env: Env = process.env): void {
  const wanted = toStartupPatch(p).env
  let originals = envOriginals.get(env)
  if (!originals) envOriginals.set(env, (originals = new Map()))
  for (const key of PERFIL_ENV_KEYS) {
    if (!originals.has(key)) originals.set(key, env[key])
    const value = wanted[key] ?? originals.get(key)
    if (value === undefined) delete env[key]
    else env[key] = value
  }
}

let bootPerfilState: ActivePerfil | undefined

// El modo bare (CLAUDE_CODE_SIMPLE) solo ofrece Bash, Read y Edit. Un perfil bare con una lista de
// herramientas pide además las que nombra (p. ej. Write y Glob en `minimo`): tools.ts las suma.
let simpleModeExtraTools: ReadonlySet<string> = new Set()

/** Herramientas extra que el modo bare debe ofrecer según el perfil activo. */
export function getSimpleModeExtraTools(): ReadonlySet<string> {
  return simpleModeExtraTools
}

export function syncSimpleModeExtraTools(p: Perfil | undefined): void {
  simpleModeExtraTools = new Set(p && p.context.bare && p.tools !== 'default' ? p.tools : [])
}

/**
 * ¿La cuenta de arranque la eligió una persona (`--account`, o la variable puesta a mano)?
 * `bin/fnharness` marca el flag con FNHARNESS_ACCOUNT_FLAG=1. Un CLAUDE_MULTIMODEL_ACCOUNT que
 * coincide con FNHARNESS_ACCOUNT y no trae esa marca es herencia de una sesión fnharness padre
 * (cada sesión exporta ambas a sus hijos): no es una elección y la cuenta del perfil lo sustituye.
 * Precedencia: --account explícito > cuenta del perfil > predeterminada.
 */
export function hasExplicitAccount(env: Env = process.env): boolean {
  const acct = env.CLAUDE_MULTIMODEL_ACCOUNT
  if (!acct) return false
  if (env.FNHARNESS_ACCOUNT_FLAG === '1') return true
  return env.FNHARNESS_ACCOUNT !== acct
}

/**
 * Se llama una vez al arrancar (cli.tsx), antes de que nada lea el entorno: resuelve el
 * perfil, aplica su entorno (incluido bare) y, si el perfil trae cuenta o modelo y la
 * persona no pasó los suyos, los pone donde los lee el resto del arranque.
 * Devuelve un error de texto si el nombre pedido no existe.
 */
export function bootPerfil(argv: readonly string[], env: Env = process.env): string | undefined {
  const r = resolveInitialPerfil(perfilNameFromArgv(argv), env)
  if (r.kind === 'error') return r.message
  if (r.kind === 'none') return undefined
  const p = r.perfil
  bootPerfilState = { name: p.name, def: p, modified: false, source: r.source }
  syncSimpleModeExtraTools(p)
  applyPerfilEnv(p, env)
  if (p.context.bare) env.CLAUDE_CODE_SIMPLE = '1'
  if (p.account && !hasExplicitAccount(env)) {
    env.CLAUDE_MULTIMODEL_ACCOUNT = p.account
    // En una cuenta Claude el modelo lo aplica main.tsx (options.model); CLAUDE_MULTIMODEL_MODEL es solo de las openai_compat.
    if (p.model && !env.CLAUDE_MULTIMODEL_MODEL && !isStoredAnthropicAccount(p.account, env)) env.CLAUDE_MULTIMODEL_MODEL = p.model
  }
  return undefined
}

/** ¿`id` es `claude` o una cuenta `kind: anthropic` de accounts.json? Lectura mínima: se usa antes de cargar nada más. */
function isStoredAnthropicAccount(id: string, env: Env): boolean {
  if (id === 'claude') return true
  try {
    const raw = JSON.parse(readFileSync(configFilePath('accounts.json', env), 'utf8')) as { accounts?: Record<string, { kind?: string }> }
    return raw.accounts?.[id]?.kind === 'anthropic'
  } catch {
    return false
  }
}

/** Perfil con el que arrancó la sesión (undefined si nadie eligió uno). */
export function getBootPerfil(): ActivePerfil | undefined {
  return bootPerfilState
}
