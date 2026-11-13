/**
 * Lectura de /proc para el directorio de sesiones: padre, entorno y línea de
 * comandos de un conjunto de procesos y de toda su cadena de ancestros. Con eso
 * el fundidor sube desde una sesión hasta la ventana de kitty o el panel de
 * tmux que la contiene. Sin /proc (otro sistema) devuelve un mapa vacío.
 */

import { readFile } from 'fs/promises'
import type { ProcInfo } from './types.js'

/** Tope de ancestros por cadena: protege de ciclos y de árboles absurdos. */
export const MAX_ANCESTOR_DEPTH = 64

/** Padre de un proceso según el contenido de `/proc/<pid>/stat`; el nombre puede llevar paréntesis. */
export function parsePpid(stat: string): number | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  // Tras el nombre: " S <ppid> ..."
  const fields = stat.slice(close + 2).split(' ')
  const ppid = parseInt(fields[1] ?? '', 10)
  return Number.isNaN(ppid) ? undefined : ppid
}

/** `/proc/<pid>/environ` (separado por NUL) a un objeto. */
export function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const item of raw.split('\0')) {
    const eq = item.indexOf('=')
    if (eq > 0) env[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return env
}

async function readOne(pid: number, withEnv: boolean): Promise<ProcInfo | null> {
  let ppid: number | undefined
  try {
    ppid = parsePpid(await readFile(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null // el proceso ya no existe
  }
  if (ppid === undefined) return null
  const [env, cmdline] = await Promise.all([
    withEnv
      ? readFile(`/proc/${pid}/environ`, 'latin1').then(parseEnviron, () => ({}))
      : Promise.resolve({}),
    readFile(`/proc/${pid}/cmdline`, 'latin1').then(
      raw => raw.replace(/\0+$/, '').replace(/\0/g, ' ').slice(0, 500) || undefined,
      () => undefined,
    ),
  ])
  return { ppid, env, cmdline }
}

/**
 * Lee los procesos `starts` y sus ancestros (hasta `MAX_ANCESTOR_DEPTH`). Los
 * pids de `skipEnv` (registros que ya traen su origen) no leen el entorno. Una
 * lectura que falla (permiso, proceso muerto) deja el entorno vacío o el pid fuera.
 */
export async function readProcs(
  starts: readonly number[],
  skipEnv: ReadonlySet<number> = new Set(),
): Promise<Record<number, ProcInfo>> {
  const procs: Record<number, ProcInfo> = {}
  const seen = new Set<number>()
  let frontier = [...new Set(starts)].filter(p => p > 1)
  for (const p of frontier) seen.add(p)
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && frontier.length > 0; depth++) {
    const level = await Promise.all(
      frontier.map(async pid => [pid, await readOne(pid, !skipEnv.has(pid))] as const),
    )
    const next: number[] = []
    for (const [pid, info] of level) {
      if (!info) continue
      procs[pid] = info
      if (info.ppid > 1 && !seen.has(info.ppid)) {
        seen.add(info.ppid)
        next.push(info.ppid)
      }
    }
    frontier = next
  }
  return procs
}
