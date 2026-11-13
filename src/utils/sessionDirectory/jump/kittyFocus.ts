/**
 * Salto a una sesión de kitty: enfoca su ventana con el control remoto de kitty.
 *
 * `kitty @ --to <listenOn> focus-window --match id:<windowId>` pide el foco, pero el
 * gestor de ventanas puede negarlo (robo de foco bloqueado). Por eso, tras la orden se
 * consulta `kitty @ ls` y solo se da por bueno si la ventana queda con `is_focused`.
 * Si no, se devuelve el comando exacto para lanzarlo a mano (p. ej. desde un atajo).
 *
 * Sin Ink ni estado global: usa `spawn` asíncrono para no congelar el buzón UDS de la
 * sesión que llama.
 */

import { spawn } from 'child_process'
import type { SessionRow } from '../types.js'

export type KittyFocusOptions = {
  /** Binario de kitty (por defecto `kitty`). */
  kittyBin?: string
  /** Tope por invocación de kitty, en ms (por defecto 3000). */
  timeoutMs?: number
  /** Espera entre comprobaciones de `ls` mientras el foco se asienta, en ms (por defecto 100). */
  pollMs?: number
}

export type KittyFocusResult = {
  ok: boolean
  message: string
  /** Línea para enfocar a mano cuando el salto automático no funcionó. */
  manualCommand?: string
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

/** Ejecuta un comando con tope de tiempo y recoge su salida. Nunca rechaza. */
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (r: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // No esperar a `close`: un nieto puede mantener abiertas las tuberías.
      finish({ code: null, stdout, stderr, timedOut })
    }, timeoutMs)
    child.stdout.on('data', d => {
      stdout += d
    })
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('error', e => finish({ code: null, stdout, stderr, timedOut, error: e.message }))
    child.on('close', code => finish({ code, stdout, stderr, timedOut }))
  })
}

/** Comprueba en la salida de `kitty @ ls` si la ventana `windowId` tiene el foco. */
export function isKittyWindowFocused(lsJson: string, windowId: number): boolean {
  let osWindows: unknown
  try {
    osWindows = JSON.parse(lsJson)
  } catch {
    return false
  }
  if (!Array.isArray(osWindows)) return false
  for (const osw of osWindows) {
    for (const tab of osw?.tabs ?? []) {
      for (const w of tab?.windows ?? []) {
        if (w?.id === windowId) return w.is_focused === true
      }
    }
  }
  return false
}

/** Línea de shell que enfoca la ventana a mano. */
export function kittyFocusCommand(listenOn: string, windowId: number, kittyBin = 'kitty'): string {
  return `${kittyBin} @ --to ${listenOn} focus-window --match id:${windowId}`
}

export async function focusKittyWindow(row: SessionRow, opts: KittyFocusOptions = {}): Promise<KittyFocusResult> {
  if (!row.kitty) return { ok: false, message: 'esta sesión no tiene ventana de kitty' }
  const { listenOn, windowId } = row.kitty
  const bin = opts.kittyBin ?? 'kitty'
  const timeoutMs = opts.timeoutMs ?? 3000
  const pollMs = opts.pollMs ?? 100
  const manualCommand = kittyFocusCommand(listenOn, windowId, bin)

  const focus = await run(bin, ['@', '--to', listenOn, 'focus-window', '--match', `id:${windowId}`], timeoutMs)
  if (focus.error || focus.timedOut || focus.code !== 0) {
    const why = focus.error
      ? focus.error
      : focus.timedOut
        ? `sin respuesta en ${timeoutMs} ms`
        : focus.stderr.trim() || `salió con código ${focus.code}`
    return { ok: false, message: `no se pudo enfocar la ventana de kitty ${windowId}: ${why}`, manualCommand }
  }

  // El foco puede tardar un instante en asentarse: hasta 3 comprobaciones.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, pollMs))
    const ls = await run(bin, ['@', '--to', listenOn, 'ls'], timeoutMs)
    if (ls.error || ls.timedOut || ls.code !== 0) {
      return {
        ok: false,
        message: `no se pudo comprobar el foco de la ventana de kitty ${windowId}: ${ls.error ?? ls.stderr.trim() ?? 'fallo de ls'}`,
        manualCommand,
      }
    }
    if (isKittyWindowFocused(ls.stdout, windowId)) {
      return { ok: true, message: `ventana de kitty ${windowId} enfocada` }
    }
  }
  return {
    ok: false,
    message: `kitty aceptó la orden pero la ventana ${windowId} no recibió el foco (el gestor de ventanas lo bloquea); lánzalo a mano`,
    manualCommand,
  }
}
