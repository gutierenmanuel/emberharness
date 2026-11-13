/**
 * Acciones detrás de /perfil, sin JSX para poder probarlas sin renderizar nada.
 */

import type { AppState } from '../../state/AppStateStore.js'
import { FULL_PROFILE } from '../../utils/contextProfile.js'
import {
  parsePerfil,
  perfilFromScope,
  restartReasons,
  type Perfil,
} from '../../utils/perfil.js'
import { applyPerfilToSession } from '../../utils/perfilRuntime.js'
import {
  createPerfilFrom,
  getPerfil,
  listPerfiles,
  loadPerfilState,
  savePerfilState,
  type ActivePerfil,
} from '../../utils/perfilStore.js'
import { activeAccountId, type ActionResult } from '../account/actions.js'

type Env = Record<string, string | undefined>
type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Perfil con el que se compara al cambiar: el activo, o uno de partida que refleja
 * cómo arrancó la sesión sin perfil (bare por entorno, hooks apagados por bare).
 */
export function sessionBaseline(current: ActivePerfil | undefined, env: Env = process.env): Perfil {
  if (current) return current.def
  const bare = env.CLAUDE_CODE_SIMPLE === '1' || env.CLAUDE_CODE_SIMPLE === 'true'
  const r = parsePerfil({ context: { bare } }, 'full')
  if (r.ok === false) throw new Error(r.error)
  return r.perfil
}

/** Una línea con lo que fija el perfil, para el selector y los mensajes. */
export function describePerfil(p: Perfil): string {
  const tools = p.tools === 'default' ? 'todas las tools' : `${p.tools.length} tools (${p.tools.join(',')})`
  const off: string[] = (
    [
      ['claudeMd', 'CLAUDE.md'],
      ['memory', 'memoria'],
      ['hooks', 'hooks'],
      ['skills', 'skills'],
    ] as const
  )
    .filter(([k]) => !p.context[k])
    .map(([, label]) => label)
  if (p.context.mcp === false) off.push('MCP')
  const mcp = Array.isArray(p.context.mcp) ? ` · MCP: ${p.context.mcp.join(',')}` : ''
  const prompt = p.systemPrompt.mode === 'default' ? '' : ` · prompt ${p.systemPrompt.mode === 'replace' ? 'propio' : 'ampliado'}`
  return `${tools}${prompt}${mcp}${p.context.bare ? ' · bare' : ''}${off.length ? ` · sin ${off.join(', ')}` : ''}`
}

export type ApplyPerfilResult =
  | { kind: 'applied'; perfil: Perfil; message: string }
  | { kind: 'restart'; perfil: Perfil; reasons: string[]; message: string }
  | { kind: 'error'; message: string }

export type ApplyPerfilDeps = {
  setAppState: SetAppState
  getAppState: () => AppState
  env?: Env
  /** Cambia de cuenta (con hooks); se inyecta para poder probarlo sin red ni cuentas reales. */
  switchAccount?: (id: string, model?: string) => Promise<ActionResult>
}

/**
 * Aplica el perfil `name` a la sesión. Si algo no se puede hacer en caliente no
 * toca la sesión: devuelve `restart` para que el llamador relance con --perfil.
 * Nunca guarda el scope en la cuenta (eso es de /scope); recuerda el perfil activo
 * en profiles.json, que es lo que usará el próximo arranque.
 */
export async function applyPerfil(name: string, deps: ApplyPerfilDeps): Promise<ApplyPerfilResult> {
  const env = deps.env ?? process.env
  const entry = getPerfil(name, env)
  if (!entry) {
    const names = listPerfiles(env).entries.map(e => e.perfil.name).join(', ')
    return { kind: 'error', message: `Perfil desconocido "${name}". Disponibles: ${names}` }
  }
  const to = entry.perfil
  const state = deps.getAppState()
  const reasons = restartReasons(sessionBaseline(state.perfil, env), to)
  savePerfilState({ ...loadPerfilState(env), active: to.name }, env)
  if (reasons.length > 0) {
    return {
      kind: 'restart',
      perfil: to,
      reasons,
      message: `Perfil ${to.name}: ${reasons.join(' y ')}; hay que reiniciar la sesión para aplicarlo.`,
    }
  }
  let accountNote = ''
  if (to.account && to.account !== activeAccountId(env) && deps.switchAccount) {
    const r = await deps.switchAccount(to.account, to.model)
    accountNote = ` ${r.message}`
    if (r.model !== undefined) {
      deps.setAppState(prev => ({ ...prev, mainLoopModel: r.model ?? null, mainLoopModelForSession: null }))
    }
  }
  applyPerfilToSession(deps.setAppState, to)
  return {
    kind: 'applied',
    perfil: to,
    message: `Perfil ${to.name} (${describePerfil(to)}). Se aplica desde el siguiente turno.${accountNote}`,
  }
}

/** `/perfil nuevo <nombre>`: escribe un JSON con lo que tiene la sesión ahora y devuelve la ruta. */
export function createPerfilFromSession(
  name: string,
  state: AppState,
  env: Env = process.env,
): { ok: true; path: string; message: string } | { ok: false; message: string } {
  const base = state.perfil?.def
  const draft = perfilFromScope(name, state.contextProfile ?? FULL_PROFILE, base)
  try {
    const path = createPerfilFrom(draft, name, env)
    return { ok: true, path, message: `Perfil "${name}" creado en ${path}. Edítalo a mano y actívalo con /perfil ${name}.` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
