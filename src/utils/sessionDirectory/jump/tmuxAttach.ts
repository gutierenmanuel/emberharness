/**
 * Salto a una sesión tmux: cede esta terminal a `tmux attach` hasta que la persona
 * se despega (`prefix d`) y devuelve el control a Ink.
 *
 * Mismo patrón que el panel de terminal (`utils/terminalPanel.ts`): se suspende Ink con
 * `enterAlternateScreen()`, se corre tmux con la terminal heredada y se reanuda con
 * `exitAlternateScreen()`. La diferencia es que el attach va con `spawn` asíncrono y no
 * con `spawnSync`: el bucle de eventos sigue vivo y el buzón UDS propio de esta sesión
 * no se congela mientras la persona está dentro de tmux.
 *
 * `buildAttachArgs` y `attachNotice` son puras; solo `attachTmux` tiene efectos.
 */

import { spawn } from 'child_process'
import instances from '../../../ink/instances.js'
import type { SessionRow } from '../types.js'

export type AttachHooks = {
  /** Suspende la UI antes de ceder la terminal (por defecto, `enterAlternateScreen` de Ink). */
  suspend?: () => void
  /** Reanuda la UI al volver (por defecto, `exitAlternateScreen` de Ink). */
  resume?: () => void
  /** Binario de tmux (por defecto `tmux`). */
  tmuxBin?: string
  /** Entorno base del hijo (por defecto `process.env`); TMUX y TMUX_PANE se borran siempre. */
  env?: NodeJS.ProcessEnv
}

export type AttachResult = { ok: boolean; message: string }

/**
 * Argumentos de `tmux` para adjuntar la sesión de la fila.
 * `-f ignore-size` evita que esta terminal encoja la ventana de otros clientes.
 * Lanza si la fila no tiene sesión tmux.
 */
export function buildAttachArgs(row: SessionRow): string[] {
  const session = row.tmux?.session
  if (!session) throw new Error('esta sesión no tiene sesión tmux')
  const socket = row.tmux?.socket
  const args: string[] = []
  if (socket && socket !== 'default') args.push('-L', socket)
  args.push('attach', '-f', 'ignore-size', '-t', session)
  return args
}

/** Aviso a mostrar antes de entrar, o undefined si no hace falta. */
export function attachNotice(row: SessionRow): string | undefined {
  if (row.origin === 'element') {
    return 'Vas a escribir en la misma TUI que el puente de Matrix; C-b d para volver'
  }
  return undefined
}

/** Entorno del hijo sin las variables que lo harían creer que ya está dentro de tmux. */
function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.TMUX
  delete env.TMUX_PANE
  return env
}

/** Ejecuta tmux capturando su salida (para comprobaciones previas). Nunca rechaza. */
function probe(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    let stderr = ''
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env })
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('error', e => resolve({ ok: false, stderr: e.message }))
    child.on('close', code => resolve({ ok: code === 0, stderr: stderr.trim() }))
  })
}

export async function attachTmux(row: SessionRow, hooks: AttachHooks = {}): Promise<AttachResult> {
  let args: string[]
  try {
    args = buildAttachArgs(row)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
  const bin = hooks.tmuxBin ?? 'tmux'
  const env = childEnv(hooks.env ?? process.env)

  // Comprobar antes de suspender Ink: así un error claro no se pierde en la pantalla alterna.
  const target = args.slice(0, args.indexOf('attach'))
  const check = await probe(bin, [...target, 'has-session', '-t', row.tmux!.session], env)
  if (!check.ok) {
    return { ok: false, message: `no se puede adjuntar la sesión tmux ${row.tmux!.session}: ${check.stderr || 'no existe'}` }
  }

  const suspend = hooks.suspend ?? (() => instances.get(process.stdout)?.enterAlternateScreen())
  const resume = hooks.resume ?? (() => instances.get(process.stdout)?.exitAlternateScreen())

  suspend()
  try {
    return await new Promise<AttachResult>(resolve => {
      const child = spawn(bin, args, { stdio: 'inherit', env })
      child.on('error', e => resolve({ ok: false, message: `no se pudo lanzar tmux: ${e.message}` }))
      child.on('close', code =>
        resolve(
          code === 0
            ? { ok: true, message: `de vuelta de la sesión tmux ${row.tmux!.session}` }
            : { ok: false, message: `tmux salió con código ${code}` },
        ),
      )
    })
  } finally {
    resume()
  }
}
