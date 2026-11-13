/**
 * Reanudar o bifurcar una sesión en esta terminal.
 *
 * "Aquí" significa que el CLI actual se cierra y el lanzador `bin/fnharness` lo relanza
 * con `--resume <sid> --chdir <cwd>` (y `--fork-session` al bifurcar). El mecanismo es el
 * de /perfil (`perfilRestart.ts`): se escribe el fichero de reinicio y se sale con 75.
 *
 * Una sesión viva solo se bifurca: reanudarla en el mismo transcript haría que dos
 * procesos escribieran el mismo `.jsonl` (`canResumeInPlace`).
 */

import { launcherCanRestart, manualRestartCommand, requestRestart } from '../../perfilRestart.js'
import { canResumeInPlace } from '../actions.js'
import type { SessionRow } from '../types.js'

export type ResumeMode = 'resume' | 'fork'

export type ResumeResult = {
  ok: boolean
  message: string
  /** Solo si no hay lanzador: el comando que la persona debe escribir a mano. */
  manualCommand?: string
}

export type ResumeDeps = {
  launcherCanRestart?: () => boolean
  requestRestart?: (args: readonly string[]) => Promise<boolean>
  /** Todas las filas del directorio, para saber si la sesión sigue viva. */
  allRows?: SessionRow[]
}

/**
 * Argumentos con los que el lanzador relanza el CLI. `--chdir` lo consume el propio
 * lanzador (hace `cd`), no llega al CLI. `--model` solo con cuentas que no son claude,
 * igual que `buildRestartArgs`.
 */
export function buildResumeArgs(row: SessionRow, mode: ResumeMode): string[] {
  if (!row.sessionId) throw new Error('la fila no tiene sessionId: no se puede reanudar')
  const args = ['--resume', row.sessionId]
  if (mode === 'fork') args.push('--fork-session')
  if (row.cwd) args.push('--chdir', row.cwd)
  if (row.account) args.push('--account', row.account)
  if (row.model && row.account && row.account !== 'claude') args.push('--model', row.model)
  return args
}

export async function resumeHere(
  row: SessionRow,
  mode: ResumeMode,
  deps: ResumeDeps = {},
): Promise<ResumeResult> {
  if (row.harness === 'claude') {
    return { ok: false, message: 'una conversacion de claude no cruza de arnes' }
  }
  if (!row.sessionId) {
    return { ok: false, message: 'la fila no tiene sessionId: no hay conversacion que reanudar' }
  }
  if (mode === 'resume') {
    const rows = deps.allRows ?? [row]
    if (!canResumeInPlace(row.sessionId, rows)) {
      return { ok: false, message: 'sigue viva: usa Bifurcar aqui' }
    }
  }

  const args = buildResumeArgs(row, mode)
  const canRestart = deps.launcherCanRestart ?? (() => launcherCanRestart())
  if (!canRestart()) {
    const manualCommand = manualRestartCommand(args)
    return {
      ok: false,
      message:
        'no hay lanzador bin/fnharness (se ejecuto ./cli directamente), asi que nadie puede relanzar esta terminal: escribe el comando a mano',
      manualCommand,
    }
  }

  const request = deps.requestRestart ?? ((a: readonly string[]) => requestRestart(a))
  const done = await request(args)
  if (!done) {
    return {
      ok: false,
      message: 'no se pudo pedir el reinicio al lanzador: escribe el comando a mano',
      manualCommand: manualRestartCommand(args),
    }
  }
  return {
    ok: true,
    message: mode === 'fork' ? 'bifurcando la sesion en esta terminal' : 'reanudando la sesion en esta terminal',
  }
}
