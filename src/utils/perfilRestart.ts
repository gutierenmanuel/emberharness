/**
 * Reinicio de la sesión para aplicar un perfil que no se puede cambiar en caliente.
 *
 * El proceso no se relanza a sí mismo: escribe los argumentos nuevos (uno por línea)
 * en `<CLAUDE_CONFIG_DIR>/restart/<pid del lanzador>.args` y sale con el código 75.
 * El lanzador `bin/fnharness` ve ese código con el fichero presente y vuelve a
 * lanzar el CLI con esos argumentos. Sin lanzador (se ejecutó ./cli directamente)
 * no hay quien relance: `launcherCanRestart` lo detecta y /perfil avisa de qué
 * comando escribir a mano.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { configFilePath } from '../services/config/hotJson.js'

type Env = Record<string, string | undefined>

/** Código de salida con el que el lanzador reconoce una petición de reinicio. */
export const RESTART_EXIT_CODE = 75

export function launcherCanRestart(env: Env = process.env): boolean {
  return Boolean(env.FNHARNESS_LAUNCHER_PID) && env.FNHARNESS_NO_RESTART !== '1'
}

export type RestartInput = {
  sessionId: string
  perfil: string
  /** Cuenta activa ahora, para que el reinicio no vuelva a la de arranque. */
  account?: string
  /** Modelo activo; solo se reenvía en cuentas que no son claude (el lanzador lo lleva en el entorno). */
  model?: string
}

/** `--resume <sid> --perfil <x>` más `--account` y `--model` para conservarlos. */
export function buildRestartArgs(i: RestartInput): string[] {
  const args = ['--resume', i.sessionId, '--perfil', i.perfil]
  if (i.account) args.push('--account', i.account)
  if (i.model && i.account && i.account !== 'claude') args.push('--model', i.model)
  return args
}

/** Línea de comando equivalente, para cuando no hay lanzador que relance. */
export function manualRestartCommand(args: readonly string[]): string {
  return `emberh ${args.map(a => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`
}

/** Escribe el fichero que lee el lanzador; devuelve su ruta (undefined sin lanzador). */
export function writeRestartFile(args: readonly string[], env: Env = process.env): string | undefined {
  if (!launcherCanRestart(env)) return undefined
  const dir = configFilePath('restart', env)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${env.FNHARNESS_LAUNCHER_PID}.args`)
  writeFileSync(path, args.join('\n') + '\n')
  return path
}

/** Pide el reinicio: escribe el fichero y cierra con el código 75. false si no hay lanzador. */
export async function requestRestart(args: readonly string[], env: Env = process.env): Promise<boolean> {
  if (!writeRestartFile(args, env)) return false
  const { gracefulShutdown } = await import('./gracefulShutdown.js')
  await gracefulShutdown(RESTART_EXIT_CODE, 'other')
  return true
}
