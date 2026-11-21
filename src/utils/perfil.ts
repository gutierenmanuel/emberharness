/**
 * Perfiles de contexto (`/perfil`, `--perfil`): un nombre que agrupa de una vez el
 * system prompt, las herramientas y qué contexto llega al modelo (CLAUDE.md,
 * memoria, hooks, MCP, skills), más una cuenta y un modelo opcionales.
 *
 * Es una capa encima del scope de `/scope` (contextProfile.ts): toScope() traduce el
 * perfil a ese scope y el resto de ejes se aplican con las variables de entorno que
 * ya miran CLAUDE.md, la memoria y los hooks.
 *
 * Todo este fichero es puro (sin fs ni estado) para poder probarlo; la lectura de
 * disco vive en perfilStore.ts.
 */

import type { ContextProfile } from './contextProfile.js'

export type PerfilPromptMode = 'default' | 'replace' | 'append'

export type PerfilPrompt = {
  mode: PerfilPromptMode
  /** Texto del prompt; perfilStore lo rellena leyendo `file` cuando solo hay fichero. */
  text?: string
  /** Ruta relativa a `<CLAUDE_CONFIG_DIR>/profiles/`. */
  file?: string
}

export type Perfil = {
  name: string
  description: string
  systemPrompt: PerfilPrompt
  /** `default` = todas las internas; una lista = solo esas. */
  tools: 'default' | string[]
  /**
   * Solo con `bare` y una lista en `tools`: la lista es exacta. Sin esto el modo bare ofrece siempre
   * Bash, Read y Edit y la lista solo añade; con esto ofrece únicamente lo que la lista nombra.
   */
  exactTools?: boolean
  context: {
    /** Modo mínimo de arranque (CLAUDE_CODE_SIMPLE): fuerza claudeMd, memory y hooks a false. */
    bare: boolean
    claudeMd: boolean
    memory: boolean
    hooks: boolean
    /** true = todos, false = ninguno, lista = solo esos servidores. */
    mcp: boolean | string[]
    skills: boolean
  }
  account?: string
  model?: string
}

export type ParsePerfilResult =
  | { ok: true; perfil: Perfil; warnings: string[] }
  | { ok: false; error: string }

/** Herramientas internas conocidas; sirve solo para avisar de erratas, no para rechazar. */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent', 'AskUserQuestion', 'Bash', 'Brief', 'Config', 'CronCreate', 'CronDelete', 'CronList',
  'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'LSP',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ListPeers', 'Monitor', 'NotebookEdit', 'PowerShell',
  'PushNotification', 'REPL', 'Read', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage',
  'SendUserMessage', 'Skill', 'Sleep', 'StructuredOutput', 'Task', 'TaskCreate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'TaskUpdate', 'TeamCreate', 'TeamDelete', 'TodoWrite', 'ToolSearch',
  'Tungsten', 'VerifyPlanExecution', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
])

const PROMPT_MODES: readonly PerfilPromptMode[] = ['default', 'replace', 'append']

/** Nombre válido de perfil (se usa como nombre de fichero). */
export const PERFIL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '')
}

function optString(o: Record<string, unknown>, key: string): string | undefined | Error {
  const v = o[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.trim() === '') return new Error(`"${key}" debe ser un texto no vacío`)
  return v
}

/** Valida un perfil leído de JSON. `name` es el del fichero o de la fábrica. */
export function parsePerfil(raw: unknown, name: string): ParsePerfilResult {
  if (!PERFIL_NAME_RE.test(name)) return { ok: false, error: `nombre de perfil no válido: "${name}"` }
  if (!isRecord(raw)) return { ok: false, error: `perfil "${name}": el JSON debe ser un objeto` }
  const warnings: string[] = []

  const description = raw.description === undefined ? '' : raw.description
  if (typeof description !== 'string') return { ok: false, error: `perfil "${name}": "description" debe ser un texto` }

  // systemPrompt
  const sp = raw.systemPrompt
  let systemPrompt: PerfilPrompt = { mode: 'default' }
  if (sp !== undefined) {
    if (!isRecord(sp)) return { ok: false, error: `perfil "${name}": "systemPrompt" debe ser un objeto` }
    const mode = sp.mode === undefined ? 'default' : sp.mode
    if (!PROMPT_MODES.includes(mode as PerfilPromptMode)) {
      return { ok: false, error: `perfil "${name}": systemPrompt.mode "${String(mode)}" no vale; usa ${PROMPT_MODES.join('|')}` }
    }
    const text = optString(sp, 'text')
    if (text instanceof Error) return { ok: false, error: `perfil "${name}": systemPrompt.${text.message}` }
    const file = optString(sp, 'file')
    if (file instanceof Error) return { ok: false, error: `perfil "${name}": systemPrompt.${file.message}` }
    if (mode !== 'default' && text === undefined && file === undefined) {
      return { ok: false, error: `perfil "${name}": systemPrompt.mode "${String(mode)}" necesita "text" o "file"` }
    }
    systemPrompt = { mode: mode as PerfilPromptMode, ...(text !== undefined ? { text } : {}), ...(file !== undefined ? { file } : {}) }
  }

  // tools
  let tools: Perfil['tools'] = 'default'
  if (raw.tools !== undefined) {
    if (raw.tools === 'default') tools = 'default'
    else if (isStringList(raw.tools)) {
      tools = raw.tools.map(t => t.trim())
      for (const t of tools) {
        if (!KNOWN_TOOL_NAMES.has(t) && !t.startsWith('mcp__')) warnings.push(`herramienta desconocida: "${t}"`)
      }
    } else return { ok: false, error: `perfil "${name}": "tools" debe ser "default" o una lista de nombres` }
  }

  let exactTools = false
  if (raw.exactTools !== undefined) {
    if (typeof raw.exactTools !== 'boolean') return { ok: false, error: `perfil "${name}": "exactTools" debe ser true o false` }
    exactTools = raw.exactTools
  }

  // context
  const ctx = raw.context === undefined ? {} : raw.context
  if (!isRecord(ctx)) return { ok: false, error: `perfil "${name}": "context" debe ser un objeto` }
  const flag = (key: string): boolean | Error => {
    const v = ctx[key]
    if (v === undefined) return true
    return typeof v === 'boolean' ? v : new Error(`context.${key} debe ser true o false`)
  }
  const bareRaw = ctx.bare === undefined ? false : ctx.bare
  if (typeof bareRaw !== 'boolean') return { ok: false, error: `perfil "${name}": context.bare debe ser true o false` }
  const claudeMd = flag('claudeMd')
  const memory = flag('memory')
  const hooks = flag('hooks')
  const skills = flag('skills')
  for (const f of [claudeMd, memory, hooks, skills]) {
    if (f instanceof Error) return { ok: false, error: `perfil "${name}": ${f.message}` }
  }
  let mcp: boolean | string[] = true
  if (ctx.mcp !== undefined) {
    if (typeof ctx.mcp === 'boolean') mcp = ctx.mcp
    else if (isStringList(ctx.mcp)) mcp = ctx.mcp.map(s => s.trim())
    else return { ok: false, error: `perfil "${name}": context.mcp debe ser true, false o una lista de servidores` }
  }

  const account = optString(raw, 'account')
  if (account instanceof Error) return { ok: false, error: `perfil "${name}": ${account.message}` }
  const model = optString(raw, 'model')
  if (model instanceof Error) return { ok: false, error: `perfil "${name}": ${model.message}` }

  const perfil: Perfil = {
    name,
    description,
    systemPrompt,
    tools,
    ...(exactTools ? { exactTools } : {}),
    context: {
      bare: bareRaw,
      // bare fuerza estos tres a false: es lo que hace CLAUDE_CODE_SIMPLE.
      claudeMd: bareRaw ? false : (claudeMd as boolean),
      memory: bareRaw ? false : (memory as boolean),
      hooks: bareRaw ? false : (hooks as boolean),
      mcp,
      skills: skills as boolean,
    },
    ...(account !== undefined ? { account } : {}),
    ...(model !== undefined ? { model } : {}),
  }
  return { ok: true, perfil, warnings }
}

/** Fábrica + usuario: el del usuario sustituye entero al de fábrica con el mismo nombre. */
export function mergePerfiles(
  factory: Readonly<Record<string, Perfil>>,
  user: Readonly<Record<string, Perfil>>,
): Record<string, Perfil> {
  return { ...factory, ...user }
}

/** Perfil -> scope de /scope (más las listas `toolNames` y `mcpServers`). */
export function toScope(p: Perfil): ContextProfile {
  const mcpList = Array.isArray(p.context.mcp)
  return {
    mcp: p.context.mcp === false ? 'none' : 'full',
    skill: p.context.skills ? 'full' : 'none',
    // Con lista el eje `tools` no se usa (manda toolNames); 'simple' evita que algo lo lea como Full.
    tools: p.tools === 'default' ? 'full' : 'simple',
    ...(p.tools !== 'default' ? { toolNames: [...p.tools] } : {}),
    ...(mcpList ? { mcpServers: [...(p.context.mcp as string[])] } : {}),
  }
}

export const ENV_NO_HOOKS = 'FNHARNESS_PERFIL_NO_HOOKS'

export type StartupPatch = {
  /** Variables de entorno que el arranque fija (solo las que el perfil apaga o activa). */
  env: Record<string, string>
  /** Equivalentes de flags de CLI; main.tsx solo los aplica donde la persona no pasó el suyo. */
  options: {
    bare?: true
    systemPrompt?: string
    appendSystemPrompt?: string
  }
}

/** Lo que un perfil impone al arrancar (lo caliente se completa con el estado de la sesión). */
export function toStartupPatch(p: Perfil): StartupPatch {
  const env: Record<string, string> = {}
  const options: StartupPatch['options'] = {}
  if (p.context.bare) {
    env.CLAUDE_CODE_SIMPLE = '1'
    options.bare = true
  }
  if (!p.context.claudeMd) env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  if (!p.context.memory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  if (!p.context.hooks) env[ENV_NO_HOOKS] = '1'
  if (p.systemPrompt.mode === 'replace' && p.systemPrompt.text) options.systemPrompt = p.systemPrompt.text
  if (p.systemPrompt.mode === 'append' && p.systemPrompt.text) options.appendSystemPrompt = p.systemPrompt.text
  return { env, options }
}

/**
 * Razones por las que pasar de `from` a `to` no se puede hacer en caliente. Vacío =
 * todo se aplica en la sesión viva. Reinicio: cambia bare (se decide al arrancar) o
 * los hooks pasan de apagados a encendidos (los de arranque ya no se ejecutaron).
 */
export function restartReasons(from: Perfil | undefined, to: Perfil): string[] {
  if (!from) return []
  const reasons: string[] = []
  if (from.context.bare !== to.context.bare) reasons.push(to.context.bare ? 'activa el modo bare' : 'desactiva el modo bare')
  if (!from.context.hooks && to.context.hooks) reasons.push('vuelve a activar los hooks')
  return reasons
}

export function requiresRestart(from: Perfil | undefined, to: Perfil): boolean {
  return restartReasons(from, to).length > 0
}

/**
 * System prompt efectivo: un flag de CLI explícito gana al perfil. `replace` solo
 * rellena `custom` si la CLI no lo trae; `append` se suma detrás del que ya hubiera.
 */
export function effectiveSystemPrompts(
  cli: { customSystemPrompt?: string; appendSystemPrompt?: string },
  perfil: Pick<Perfil, 'systemPrompt'> | undefined,
  vars?: PromptVars,
): { customSystemPrompt?: string; appendSystemPrompt?: string } {
  const sp = perfil?.systemPrompt
  if (!sp || sp.mode === 'default' || !sp.text) return cli
  const text = expandPromptVars(sp.text, vars)
  if (sp.mode === 'replace') {
    return { ...cli, customSystemPrompt: cli.customSystemPrompt ?? text }
  }
  const append = [cli.appendSystemPrompt, text].filter(Boolean).join('\n\n')
  return { ...cli, appendSystemPrompt: append }
}

export type PromptVars = { cwd?: string }

/**
 * Sustituye `{cwd}` en el texto de un prompt de perfil por el directorio de trabajo. Un
 * prompt de reemplazo no lleva la información de entorno del prompt por defecto, y un modelo
 * pequeño que no sabe dónde está inventa rutas (/tmp/...) al escribir ficheros.
 */
export function expandPromptVars(text: string, vars?: PromptVars): string {
  return vars?.cwd === undefined ? text : text.replaceAll('{cwd}', vars.cwd)
}

export type PerfilArgs =
  | { kind: 'list' }
  | { kind: 'use'; name: string }
  | { kind: 'new'; name: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** `''` | `'<nombre>'` | `'nuevo <nombre>'` | `'help'`. */
export function parsePerfilArgs(args: string): PerfilArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'list' }
  const [first, ...rest] = tokens as [string, ...string[]]
  if (['help', '-h', '--help'].includes(first)) return { kind: 'help' }
  if (first === 'nuevo' || first === 'new') {
    if (rest.length !== 1) return { kind: 'error', message: 'Uso: /perfil nuevo <nombre>' }
    const name = rest[0]!
    if (!PERFIL_NAME_RE.test(name)) return { kind: 'error', message: `Nombre no válido: "${name}" (letras, números, _ y -)` }
    return { kind: 'new', name }
  }
  if (rest.length > 0) return { kind: 'error', message: `No entiendo "${args.trim()}". Uso: /perfil [<nombre> | nuevo <nombre>]` }
  if (!PERFIL_NAME_RE.test(first)) return { kind: 'error', message: `Nombre no válido: "${first}" (letras, números, _ y -)` }
  return { kind: 'use', name: first }
}

/** Perfil mínimo que describe la sesión actual para `/perfil nuevo`. */
export function perfilFromScope(name: string, scope: ContextProfile, base: Perfil | undefined): Perfil {
  const tools: Perfil['tools'] = scope.toolNames
    ? [...scope.toolNames]
    : scope.tools === 'full'
      ? 'default'
      : scope.tools === 'simple'
        ? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent']
        : []
  return {
    name,
    description: base ? `copia de ${base.name}` : 'perfil nuevo',
    systemPrompt: base?.systemPrompt ?? { mode: 'default' },
    tools,
    context: {
      bare: base?.context.bare ?? false,
      claudeMd: base?.context.claudeMd ?? true,
      memory: base?.context.memory ?? true,
      hooks: base?.context.hooks ?? true,
      mcp: scope.mcpServers ? [...scope.mcpServers] : scope.mcp !== 'none',
      skills: scope.skill !== 'none',
    },
    ...(base?.account ? { account: base.account } : {}),
    ...(base?.model ? { model: base.model } : {}),
  }
}

/** JSON listo para escribir a disco (sin `name`, que es el del fichero). */
export function perfilToJson(p: Perfil): Record<string, unknown> {
  const { name: _name, ...rest } = p
  const { text, file, mode } = p.systemPrompt
  return {
    ...rest,
    systemPrompt: { mode, ...(file ? { file } : text ? { text } : {}) },
  }
}
