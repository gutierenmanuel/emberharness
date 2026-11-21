/**
 * Ajustes de la propia sesión que el agente (o otra sesión por el socket) puede
 * cambiar en caliente: modelo, esfuerzo, thinking, modo de permisos y perfil.
 *
 * Una sola función de aplicar sirve a la tool `SessionConfig` y al canal de
 * control del socket UDS, así las dos siguen la misma allowlist y la misma regla
 * de confirmación. Nada de lo que se aplica aquí se guarda en los ajustes del
 * usuario: es solo de esta sesión (el modelo va a `mainLoopModelForSession`, que
 * `onChangeAppState` no persiste, a diferencia de `mainLoopModel`).
 *
 * Reglas:
 *  - Allowlist cerrada (`SESSION_CONFIG_OPS`); cualquier otra clave se rechaza.
 *  - Subir permisos (`acceptEdits`, `dontAsk`, `auto`, `bypassPermissions`),
 *    cambiar de perfil y encender el micrófono (`voiceListen` on) exigen confirmación de la persona. Desde el socket nunca
 *    se aplican sin ella: `applySessionConfig` devuelve `needsConfirm`.
 *  - Cada cambio (o petición pendiente) se anota en
 *    `<config dir>/peer-log/session-config.jsonl`.
 *  - Los perfiles o cuentas de la rama ciber no son accesibles desde aquí.
 */
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppState } from '../state/AppStateStore.js'
import { getPeerLogDir } from './peerLog.js'
import { voiceListenStatus } from './voiceListenRuntime.js'

export const SESSION_CONFIG_OPS = ['model', 'effort', 'thinking', 'permissionMode', 'perfil', 'voiceListen'] as const
export type SessionConfigOp = (typeof SESSION_CONFIG_OPS)[number]
export type SessionConfigOrigin = 'tool' | 'socket'

/** Modos de permiso que la persona puede pedir por esta vía. */
export const PERMISSION_MODE_VALUES = ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'] as const
/** Modos que dan más poder al agente: piden confirmación. */
export const RAISING_PERMISSION_MODES: readonly string[] = ['acceptEdits', 'dontAsk', 'auto', 'bypassPermissions']
export const EFFORT_VALUES = ['low', 'medium', 'high', 'max', 'auto'] as const

type SetAppState = (f: (prev: AppState) => AppState) => void
export type SessionConfigHost = { getAppState: () => AppState; setAppState: SetAppState }

let registeredHost: SessionConfigHost | null = null

/** El REPL registra aquí su store al montarse para que el socket pueda aplicar cambios. */
export function registerSessionConfigHost(host: SessionConfigHost | null): void {
  registeredHost = host
}
export function getSessionConfigHost(): SessionConfigHost | null {
  return registeredHost
}

export function isSessionConfigEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FNHARNESS_SESSION_CONFIG === '1'
}

export type NormalizedValue = { ok: true; value: string | boolean } | { ok: false; error: string }

const RESTRICTED_NAME = /cyber|ciber/i

/** Valida y normaliza el valor de una op. No toca nada. */
export function normalizeValue(op: string, raw: unknown): NormalizedValue {
  if (!(SESSION_CONFIG_OPS as readonly string[]).includes(op)) {
    return { ok: false, error: `Ajuste no permitido: "${op}". Permitidos: ${SESSION_CONFIG_OPS.join(', ')}` }
  }
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: false, error: `Falta el valor de ${op}` }
  }
  const text = String(raw).trim()
  switch (op as SessionConfigOp) {
    case 'model':
      if (!/^[\w.\-:/@[\]]+$/.test(text)) return { ok: false, error: `Nombre de modelo no válido: "${text}"` }
      if (RESTRICTED_NAME.test(text)) return { ok: false, error: 'Ese modelo no es accesible desde SessionConfig' }
      return { ok: true, value: text }
    case 'effort': {
      const v = text.toLowerCase()
      if (!(EFFORT_VALUES as readonly string[]).includes(v)) {
        return { ok: false, error: `effort no válido: "${text}". Opciones: ${EFFORT_VALUES.join(', ')}` }
      }
      return { ok: true, value: v }
    }
    case 'thinking': {
      const v = text.toLowerCase()
      if (['on', 'true', 'enabled', '1'].includes(v)) return { ok: true, value: true }
      if (['off', 'false', 'disabled', '0'].includes(v)) return { ok: true, value: false }
      return { ok: false, error: `thinking no válido: "${text}". Opciones: on, off` }
    }
    case 'permissionMode': {
      if (!(PERMISSION_MODE_VALUES as readonly string[]).includes(text)) {
        return { ok: false, error: `permissionMode no válido: "${text}". Opciones: ${PERMISSION_MODE_VALUES.join(', ')}` }
      }
      return { ok: true, value: text }
    }
    case 'voiceListen': {
      const v = text.toLowerCase()
      if (['on', 'true', 'enabled', '1'].includes(v)) return { ok: true, value: 'on' }
      if (['off', 'false', 'disabled', '0'].includes(v)) return { ok: true, value: 'off' }
      return { ok: false, error: `voiceListen no válido: "${text}". Opciones: on, off` }
    }
    case 'perfil':
      if (!/^[\w.-]+$/.test(text)) return { ok: false, error: `Nombre de perfil no válido: "${text}"` }
      if (RESTRICTED_NAME.test(text)) return { ok: false, error: 'Ese perfil no es accesible desde SessionConfig' }
      return { ok: true, value: text }
  }
}

/** ¿Hay que preguntar a la persona antes de aplicar? Subir permisos, cambiar de perfil y encender el micrófono. */
export function requiresConfirmation(op: string, value: unknown): boolean {
  if (op === 'perfil') return true
  if (op === 'voiceListen') return value === 'on'
  if (op === 'permissionMode') return typeof value === 'string' && RAISING_PERMISSION_MODES.includes(value)
  return false
}

/** Lectura del estado actual de los ajustes permitidos. */
export function readSessionConfig(state: AppState): Record<SessionConfigOp, string | boolean> {
  return {
    model: String(state.mainLoopModelForSession ?? state.mainLoopModel ?? 'default'),
    effort: state.effortValue === undefined ? 'auto' : String(state.effortValue),
    thinking: state.thinkingEnabled !== false,
    permissionMode: state.toolPermissionContext.mode,
    perfil: state.perfil ? `${state.perfil.name}${state.perfil.modified ? '*' : ''}` : 'ninguno',
    voiceListen: voiceListenStatus().running ? 'on' : 'off',
  }
}

export type SessionConfigRequest = {
  op: string
  value?: unknown
  origin: SessionConfigOrigin
  /** La persona ya confirmó (la tool pasa por checkPermissions → ask antes de llamar). */
  confirmed: boolean
  /** Dirección del emisor cuando viene por el socket. */
  from?: string
}

export type SessionConfigResult = {
  ok: boolean
  applied: boolean
  needsConfirm: boolean
  op: string
  from?: string | boolean
  to?: string | boolean
  message?: string
  error?: string
  /** Reinicio pendiente (perfil): la tool lo ejecuta tras devolver el resultado. */
  restart?: { args: string[] } | { manual: string }
}

export type SessionConfigDeps = {
  validateModel?: (model: string) => Promise<{ valid: boolean; error?: string }>
  logPath?: string
  now?: () => number
}

export function sessionConfigLogPath(): string {
  return join(getPeerLogDir(), 'session-config.jsonl')
}

/** Anota un cambio o una petición pendiente; nunca lanza. */
export function logSessionConfig(
  entry: { op: string; de?: unknown; a?: unknown; origen: SessionConfigOrigin; applied: boolean; pending?: boolean; remitente?: string },
  deps: SessionConfigDeps = {},
): void {
  try {
    const path = deps.logPath ?? sessionConfigLogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    const line = { ts: (deps.now ?? Date.now)(), pid: process.pid, ...entry }
    appendFileSync(path, JSON.stringify(line) + '\n')
  } catch {
    // el registro es auditoría, no puede romper el cambio
  }
}

function fail(op: string, error: string): SessionConfigResult {
  return { ok: false, applied: false, needsConfirm: false, op, error }
}

/**
 * Aplica (o pide confirmar) un cambio. Sin `confirmed`, lo que exige confirmación
 * no se toca: se devuelve `needsConfirm: true`.
 */
export async function applySessionConfig(
  req: SessionConfigRequest,
  host: SessionConfigHost | null = registeredHost,
  deps: SessionConfigDeps = {},
): Promise<SessionConfigResult> {
  const { op } = req
  if (!host) return fail(op, 'La sesión no tiene el control de ajustes disponible (aún no ha arrancado la interfaz)')
  const norm = normalizeValue(op, req.value)
  if (norm.ok === false) return fail(op, norm.error)
  const value = norm.value
  const state = host.getAppState()
  const before = readSessionConfig(state)[op as SessionConfigOp]
  const log = (applied: boolean, pending = false) =>
    logSessionConfig({ op, de: before, a: value, origen: req.origin, applied, pending, remitente: req.from }, deps)

  if (requiresConfirmation(op, value) && !req.confirmed) {
    log(false, true)
    return { ok: true, applied: false, needsConfirm: true, op, from: before, to: value }
  }

  switch (op as SessionConfigOp) {
    case 'model': {
      const model = String(value)
      const validate = deps.validateModel ?? (await import('./model/validateModel.js')).validateModel
      const v = await validate(model)
      if (!v.valid) return fail(op, v.error ?? `Modelo no válido: ${model}`)
      // mainLoopModelForSession NO se persiste en ajustes (mainLoopModel sí).
      host.setAppState(prev => ({ ...prev, mainLoopModelForSession: model as AppState['mainLoopModelForSession'] }))
      log(true)
      return { ok: true, applied: true, needsConfirm: false, op, from: before, to: model, message: `Modelo ${model} solo para esta sesión; se usa desde el siguiente turno.` }
    }
    case 'effort': {
      const level = String(value)
      const next = level === 'auto' ? undefined : (level as AppState['effortValue'])
      host.setAppState(prev => ({ ...prev, effortValue: next }))
      log(true)
      const envNote = process.env.CLAUDE_CODE_EFFORT_LEVEL ? ` Ojo: CLAUDE_CODE_EFFORT_LEVEL=${process.env.CLAUDE_CODE_EFFORT_LEVEL} lo sigue pisando.` : ''
      return { ok: true, applied: true, needsConfirm: false, op, from: before, to: level, message: `Effort ${level} solo para esta sesión.${envNote}` }
    }
    case 'thinking': {
      host.setAppState(prev => ({ ...prev, thinkingEnabled: value === true }))
      log(true)
      return { ok: true, applied: true, needsConfirm: false, op, from: before, to: value, message: `Thinking ${value ? 'activado' : 'desactivado'} desde el siguiente turno.` }
    }
    case 'permissionMode':
      return applyPermissionMode(String(value), host, before, req, log)
    case 'perfil':
      return applyPerfilOp(String(value), host, before, log)
    case 'voiceListen':
      return applyVoiceListenOp(String(value), before, log)
  }
}

/** Enciende o apaga la escucha por voz de esta sesión (la misma función que usa /escucha). */
async function applyVoiceListenOp(
  value: string,
  before: string | boolean,
  log: (applied: boolean, pending?: boolean) => void,
): Promise<SessionConfigResult> {
  const op = 'voiceListen'
  const { startVoiceListen, stopVoiceListen } = await import('./voiceListenRuntime.js')
  if (value === 'off') {
    stopVoiceListen()
    log(true)
    return { ok: true, applied: true, needsConfirm: false, op, from: before, to: 'off', message: 'Escucha por voz apagada.' }
  }
  const r = startVoiceListen()
  if (!r.started && r.reason === 'locked') return fail(op, 'Otra sesión ya está escuchando (lock tomado); apágala allí primero')
  if (!r.started && r.reason === 'empty_cmd') return fail(op, 'FNHARNESS_VOICE_CMD está vacío')
  log(true)
  return { ok: true, applied: true, needsConfirm: false, op, from: before, to: 'on', message: 'Escucha por voz encendida: lo que diga la persona llegará como mensaje suyo.' }
}

async function applyPermissionMode(
  mode: string,
  host: SessionConfigHost,
  before: string | boolean,
  req: SessionConfigRequest,
  log: (applied: boolean, pending?: boolean) => void,
): Promise<SessionConfigResult> {
  const op = 'permissionMode'
  const ps = await import('./permissions/permissionSetup.js')
  const ctx = host.getAppState().toolPermissionContext
  if (mode === 'bypassPermissions') {
    if (ps.isBypassPermissionsModeDisabled()) return fail(op, 'bypassPermissions está desactivado por la configuración')
    if (!ctx.isBypassPermissionsModeAvailable) return fail(op, 'bypassPermissions no está disponible: la sesión no se lanzó con --dangerously-skip-permissions')
  }
  if (mode === 'auto' && !ps.isAutoModeGateEnabled()) {
    const reason = ps.getAutoModeUnavailableReason()
    return fail(op, reason ? `No se puede pasar a auto: ${ps.getAutoModeUnavailableNotification(reason)}` : 'No se puede pasar a auto')
  }
  try {
    host.setAppState(prev => {
      const current = prev.toolPermissionContext.mode
      if (current === mode) return prev
      const next = ps.transitionPermissionMode(current, mode, prev.toolPermissionContext)
      return { ...prev, toolPermissionContext: { ...next, mode: mode as AppState['toolPermissionContext']['mode'] } }
    })
  } catch (e) {
    return fail(op, e instanceof Error ? e.message : String(e))
  }
  log(true)
  return { ok: true, applied: true, needsConfirm: false, op, from: before, to: mode, message: `Modo de permisos ${mode} solo para esta sesión.` }
}

async function applyPerfilOp(
  name: string,
  host: SessionConfigHost,
  before: string | boolean,
  log: (applied: boolean, pending?: boolean) => void,
): Promise<SessionConfigResult> {
  const op = 'perfil'
  const [{ applyPerfil }, { activeAccountId, switchAccountWithHooks }, restart, { getSessionId }] = await Promise.all([
    import('../commands/perfil/actions.js'),
    import('../commands/account/actions.js'),
    import('./perfilRestart.js'),
    import('../bootstrap/state.js'),
  ])
  // Un perfil de la rama ciber no se aplica desde aquí, ni por nombre ni por cuenta.
  const { getPerfil } = await import('./perfilStore.js')
  const entry = getPerfil(name)
  if (entry?.perfil.account && RESTRICTED_NAME.test(entry.perfil.account)) {
    return fail(op, 'Ese perfil no es accesible desde SessionConfig')
  }
  const r = await applyPerfil(name, {
    setAppState: host.setAppState,
    getAppState: host.getAppState,
    switchAccount: (id, model) => switchAccountWithHooks(id, model),
  })
  if (r.kind === 'error') return fail(op, r.message)
  log(true)
  if (r.kind === 'applied') {
    return { ok: true, applied: true, needsConfirm: false, op, from: before, to: name, message: r.message }
  }
  const state = host.getAppState()
  const args = restart.buildRestartArgs({
    sessionId: getSessionId(),
    perfil: r.perfil.name,
    account: r.perfil.account ?? activeAccountId(),
    model: r.perfil.account ? r.perfil.model : (state.mainLoopModel ?? undefined),
  })
  if (!restart.launcherCanRestart()) {
    return { ok: true, applied: false, needsConfirm: false, op, from: before, to: name, message: `${r.message} No hay lanzador que relance; la persona debe ejecutar: ${restart.manualRestartCommand(args)}`, restart: { manual: restart.manualRestartCommand(args) } }
  }
  return { ok: true, applied: true, needsConfirm: false, op, from: before, to: name, message: `${r.message} Reiniciando la sesión en un momento.`, restart: { args } }
}

/** Texto meta que se encola en la sesión cuando una petición del socket exige confirmar. */
export function buildConfirmRequestText(r: SessionConfigResult, from?: string): string {
  return [
    `Otra sesión${from ? ` (${from})` : ''} pide cambiar un ajuste de ESTA sesión y requiere confirmación de la persona.`,
    `Ajuste: ${r.op}: ${String(r.from)} -> ${String(r.to)}. NO se ha aplicado.`,
    `Pregunta a la persona si lo permite y, solo si confirma, llama a la tool SessionConfig con {"op":"${r.op}","value":${JSON.stringify(r.to)}}. Si no confirma, no hagas nada.`,
  ].join('\n')
}
