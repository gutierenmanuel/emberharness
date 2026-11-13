/**
 * Fuentes de terminales del directorio de sesiones: el estado de Element
 * (matrix_terminals), los paneles de tmux y las ventanas de kitty. Cada lector
 * tolera que la herramienta no exista o falle y devuelve vacío en ese caso.
 */

import { execFile } from 'child_process'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  ElementConversation,
  ElementState,
  KittyWindow,
  TmuxPane,
} from './types.js'

/** Directorio de estado de Element: `MATRIX_TERMINALS_STATE_DIR` o `~/.local/state/matrix_terminals`. */
export function matrixStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MATRIX_TERMINALS_STATE_DIR || join(homedir(), '.local', 'state', 'matrix_terminals')
}

/** Directorio donde kitty deja sus sockets (`kitty-<pid>`): `FNHARNESS_KITTY_SOCKET_DIR` o /tmp. */
export function kittySocketDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FNHARNESS_KITTY_SOCKET_DIR || '/tmp'
}

/** Ejecuta un binario con tope de tiempo; null si no existe, falla o se pasa del tope. */
export function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve(err ? null : stdout),
      )
    } catch {
      resolve(null)
    }
  })
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Un `<sesion>.json` de Element a ElementState; null si no trae `session` y `socket`. */
export function parseElementState(
  agent: string,
  stateFile: string,
  raw: unknown,
): ElementState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const session = str(r.session)
  const socket = str(r.socket)
  if (!session || !socket) return null
  return {
    agent,
    stateFile,
    session,
    socket,
    sessionId: str(r.session_id),
    workdir: str(r.workdir),
    configDir: str(r.config_dir),
    startedAt: str(r.started_at),
  }
}

/** Un `conversations-<agente>.json` a sus conversaciones. */
export function parseElementConversations(agent: string, raw: unknown): ElementConversation[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { conversations?: unknown }).conversations
  if (!Array.isArray(list)) return []
  const out: ElementConversation[] = []
  for (const c of list) {
    if (typeof c !== 'object' || c === null) continue
    const r = c as Record<string, unknown>
    const session = str(r.session)
    if (!session) continue
    out.push({
      agent,
      roomId: str(r.room_id),
      session,
      title: str(r.title),
      claudeSessionId: str(r.claude_session_id),
      workdir: str(r.workdir),
      status: str(r.status),
      lastActivity: str(r.last_activity),
    })
  }
  return out
}

/** Lee `<dir>/<agente>/*.json`: estados de sesión y conversaciones. */
export async function readElement(
  dir: string,
): Promise<{ states: ElementState[]; conversations: ElementConversation[] }> {
  let agents: string[]
  try {
    agents = (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return { states: [], conversations: [] }
  }
  const perAgent = await Promise.all(
    agents.map(async agent => {
      let files: string[]
      try {
        files = await readdir(join(dir, agent))
      } catch {
        return { states: [], conversations: [] }
      }
      const states: ElementState[] = []
      const conversations: ElementConversation[] = []
      await Promise.all(
        files
          .filter(f => f.endsWith('.json') && !f.startsWith('conv-pool-'))
          .map(async f => {
            const path = join(dir, agent, f)
            const raw = await readJson(path)
            if (f.startsWith('conversations-')) {
              conversations.push(...parseElementConversations(agent, raw))
            } else {
              const s = parseElementState(agent, path, raw)
              if (s) states.push(s)
            }
          }),
      )
      return { states, conversations }
    }),
  )
  return {
    states: perAgent.flatMap(a => a.states),
    conversations: perAgent.flatMap(a => a.conversations),
  }
}

/** Salida de `list-panes -F '#{session_name}\t#{pane_pid}'` a paneles. */
export function parseTmuxPanes(socket: string, out: string): TmuxPane[] {
  const panes: TmuxPane[] = []
  for (const line of out.split('\n')) {
    const tab = line.lastIndexOf('\t')
    if (tab < 0) continue
    const panePid = parseInt(line.slice(tab + 1), 10)
    if (Number.isNaN(panePid)) continue
    panes.push({ socket, session: line.slice(0, tab), panePid })
  }
  return panes
}

/** Paneles de un servidor tmux (`tmux -L <socket>`); vacío si tmux no existe o el servidor no corre. */
export async function listTmuxPanes(socket: string, timeoutMs: number): Promise<TmuxPane[]> {
  const out = await runCapture(
    'tmux',
    ['-L', socket, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'],
    timeoutMs,
  )
  return out === null ? [] : parseTmuxPanes(socket, out)
}

/** Aplana la salida de `kitty @ ls` (ventanas de SO > pestañas > ventanas). */
export function flattenKittyLs(listenOn: string, json: unknown): KittyWindow[] {
  const out: KittyWindow[] = []
  if (!Array.isArray(json)) return out
  for (const osWin of json) {
    for (const tab of osWin?.tabs ?? []) {
      for (const w of tab?.windows ?? []) {
        if (typeof w?.id !== 'number' || typeof w?.pid !== 'number') continue
        const fg: unknown[] = Array.isArray(w.foreground_processes) ? w.foreground_processes : []
        out.push({
          listenOn,
          windowId: w.id,
          pid: w.pid,
          foregroundPids: fg
            .map(p => (p as { pid?: unknown })?.pid)
            .filter((p): p is number => typeof p === 'number'),
          cwd: str(w.cwd),
          title: str(w.title),
          isFocused: w.is_focused === true,
        })
      }
    }
  }
  return out
}

/** Sockets `kitty-*` del directorio que de verdad son sockets (los ficheros de log no). */
export async function findKittySockets(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.startsWith('kitty-'))
  } catch {
    return []
  }
  const checked = await Promise.all(
    names.map(async n => {
      try {
        return (await stat(join(dir, n))).isSocket() ? join(dir, n) : null
      } catch {
        return null
      }
    }),
  )
  return checked.filter((p): p is string => p !== null)
}

/** Ventanas de todos los kitty vivos; los sockets caducados fallan solos y se ignoran. */
export async function listKittyWindows(dir: string, timeoutMs: number): Promise<KittyWindow[]> {
  const sockets = await findKittySockets(dir)
  const perSocket = await Promise.all(
    sockets.map(async path => {
      const listenOn = `unix:${path}`
      const out = await runCapture('kitty', ['@', '--to', listenOn, 'ls'], timeoutMs)
      if (out === null) return []
      try {
        return flattenKittyLs(listenOn, JSON.parse(out))
      } catch {
        return []
      }
    }),
  )
  return perSocket.flat()
}
