/**
 * Detección pura del origen de una sesión: de qué terminal o lanzador cuelga.
 *
 * `detectOrigin` mira solo el entorno y los campos `kind`/`entrypoint` del registro.
 * Una variable de kitty en el entorno es únicamente un candidato: puede venir de un
 * `KITTY_LISTEN_ON` caducado heredado por un proceso que ya no cuelga de kitty. La
 * confirmación la hace `findKittyWindow`, subiendo por los padres hasta una ventana
 * que `kitty @ ls` siga listando.
 */

import type { KittyWindow, ProcInfo, RecordOrigin } from './types.js'

export type DetectOriginArgs = {
  /** Entorno del proceso (de /proc/<pid>/environ); vacío si no se pudo leer. */
  env: Record<string, string | undefined>
  /** `kind` del registro de sesión (interactive, bg, daemon, daemon-worker...). */
  kind?: string
  /** `entrypoint` del registro (cli, sdk-cli, sdk-ts...). */
  entrypoint?: string
}

export type OriginHint = {
  /**
   * Mejor suposición por entorno. `'kitty'` es solo un candidato sin confirmar y
   * solo sale cuando no hay nada más fuerte (tmux incluido); `undefined` si nada encaja.
   */
  origin: 'element' | 'bg' | 'headless' | 'tmux' | 'kitty' | undefined
  /** KITTY_WINDOW_ID está definido (aunque haya ganado otro origen). */
  kittyCandidate: boolean
  /** Nombre del socket tmux (basename de TMUX antes de la primera coma). */
  tmuxSocket?: string
  kittyWindowId?: number
  kittyListenOn?: string
}

/** Tope de saltos al subir por la cadena de padres. */
const MAX_HOPS = 64

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v
}

/** Nombre del socket tmux a partir de `$TMUX` (`/tmp/tmux-1000/matrixterm,123,0`). */
export function tmuxSocketFromEnv(tmuxVar: string | undefined): string | undefined {
  const v = nonEmpty(tmuxVar)
  if (!v) return undefined
  const path = v.split(',')[0] ?? ''
  const base = path.split('/').filter(Boolean).pop()
  return base || undefined
}

export function detectOrigin(args: DetectOriginArgs): OriginHint {
  const { env, kind, entrypoint } = args
  const tmuxSocket = tmuxSocketFromEnv(env.TMUX)
  const term = env.TERM ?? ''
  const inTmux =
    tmuxSocket !== undefined && (term.startsWith('screen') || term.startsWith('tmux'))
  const kittyId = nonEmpty(env.KITTY_WINDOW_ID)
  const kittyNum = kittyId !== undefined ? Number(kittyId) : NaN
  const hint: Omit<OriginHint, 'origin'> = {
    kittyCandidate: kittyId !== undefined,
    ...(inTmux ? { tmuxSocket } : {}),
    ...(Number.isFinite(kittyNum) ? { kittyWindowId: kittyNum } : {}),
    ...(nonEmpty(env.KITTY_LISTEN_ON) ? { kittyListenOn: env.KITTY_LISTEN_ON } : {}),
  }

  if (nonEmpty(env.CLAUDE_TERM_SESSION)) return { ...hint, origin: 'element' }
  if (kind === 'bg') return { ...hint, origin: 'bg' }
  if (
    (entrypoint ?? '').startsWith('sdk') ||
    kind === 'daemon' ||
    kind === 'daemon-worker'
  ) {
    return { ...hint, origin: 'headless' }
  }
  if (inTmux) return { ...hint, origin: 'tmux' }
  if (kittyId !== undefined) return { ...hint, origin: 'kitty' }
  return { ...hint, origin: undefined }
}

/**
 * Cadena [pid, padre, abuelo...] según `procs`. Corta en un ciclo, al faltar el
 * proceso en `procs` (el último padre sí se incluye) o tras 64 saltos.
 */
export function ancestorChain(pid: number, procs: Record<number, ProcInfo>): number[] {
  const chain: number[] = []
  const seen = new Set<number>()
  let cur = pid
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (seen.has(cur) || cur <= 0) break
    seen.add(cur)
    chain.push(cur)
    const info = procs[cur]
    if (!info) break
    cur = info.ppid
  }
  return chain
}

/**
 * Ventana de kitty que contiene al proceso: sube por los padres hasta un pid que sea
 * el de una ventana o esté entre sus procesos en primer plano. Solo cuenta lo que
 * `kitty @ ls` lista hoy, así que un socket caducado nunca confirma nada.
 */
export function findKittyWindow(
  pid: number,
  procs: Record<number, ProcInfo>,
  kittyWindows: KittyWindow[],
): KittyWindow | undefined {
  if (kittyWindows.length === 0) return undefined
  for (const p of ancestorChain(pid, procs)) {
    const hit = kittyWindows.find(w => w.pid === p || w.foregroundPids.includes(p))
    if (hit) return hit
  }
  return undefined
}

/** Ventana indicada por el propio registro (`origin.kittyWindowId` + `kittyListenOn`), si sigue viva. */
export function findKittyWindowByRecord(
  recordOrigin: RecordOrigin | undefined,
  kittyWindows: KittyWindow[],
): KittyWindow | undefined {
  if (recordOrigin?.kittyWindowId === undefined || !recordOrigin.kittyListenOn) return undefined
  return kittyWindows.find(
    w => w.windowId === recordOrigin.kittyWindowId && w.listenOn === recordOrigin.kittyListenOn,
  )
}
