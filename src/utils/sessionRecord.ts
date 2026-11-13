/**
 * Datos de origen que cada sesión escribe en su propio `sessions/<pid>.json`.
 *
 * El directorio de sesiones (`/sesiones`, selector de ←) necesita saber en qué
 * ventana de kitty, sesión de tmux o sala de Element vive cada sesión. Leerlo
 * del entorno de otro proceso (/proc/<pid>/environ) no siempre es posible, así
 * que la sesión lo declara ella misma al registrarse. Función pura: recibe el
 * entorno, no lo lee ni toca disco.
 */

import { basename } from 'path'
import type { RecordOrigin } from './sessionDirectory/types.js'

type Env = Record<string, string | undefined>

/** Entero positivo de una variable de entorno, o undefined si no lo es. */
function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
  const n = parseInt(raw, 10)
  return n > 0 ? n : undefined
}

const nonEmpty = (raw: string | undefined): string | undefined =>
  raw !== undefined && raw.trim() !== '' ? raw : undefined

/**
 * Origen de esta sesión según su entorno. Solo incluye las claves que se
 * pueden saber; un entorno sin terminal conocida da `{}`.
 *
 * - kitty: `KITTY_WINDOW_ID` y `KITTY_LISTEN_ON`.
 * - tmux: `TMUX` (`<ruta del socket>,<pid>,<n>`) solo si `TERM` es `screen*` o
 *   `tmux*`; el socket es el nombre de fichero del primer campo. La sesión de
 *   tmux no se resuelve (haría falta ejecutar `tmux display`): solo se toma de
 *   `CLAUDE_TERM_SESSION`, que pone Element.
 * - Element: `MATRIX_TERMINAL_STATE_FILE`.
 * - `FNHARNESS_LAUNCHER_PID`: el lanzador `bin/fnharness`.
 */
export function buildRecordOrigin(env: Env): RecordOrigin {
  const origin: RecordOrigin = {}

  const kittyWindowId = positiveInt(env.KITTY_WINDOW_ID)
  if (kittyWindowId !== undefined) origin.kittyWindowId = kittyWindowId
  const kittyListenOn = nonEmpty(env.KITTY_LISTEN_ON)
  if (kittyListenOn) origin.kittyListenOn = kittyListenOn

  if (nonEmpty(env.TMUX) && /^(screen|tmux)/.test(env.TERM ?? '')) {
    const socketPath = env.TMUX!.split(',')[0]!
    const socket = socketPath ? basename(socketPath) : ''
    if (socket) origin.tmuxSocket = socket
    const session = nonEmpty(env.CLAUDE_TERM_SESSION)
    if (session) origin.tmuxSession = session
  }

  const stateFile = nonEmpty(env.MATRIX_TERMINAL_STATE_FILE)
  if (stateFile) origin.matrixStateFile = stateFile

  const launcherPid = positiveInt(env.FNHARNESS_LAUNCHER_PID)
  if (launcherPid !== undefined) origin.launcherPid = launcherPid

  return origin
}
