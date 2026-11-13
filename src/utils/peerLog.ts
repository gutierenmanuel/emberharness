/**
 * Historial de las conversaciones entre sesiones (mensajes `<cross-session-message>`).
 *
 * Cada mensaje que una sesión recibe por su socket UDS se anota aquí, una sola vez
 * (la sesión receptora es el único escritor, así que no hay duplicados). El historial
 * se separa en dos canales con un fichero JSONL cada uno bajo `<config dir>/peer-log/`:
 *
 *   - `normal.jsonl`: conversaciones entre sesiones normales.
 *   - `cyber.jsonl`: toda conversación en la que participa al menos una sesión cyber
 *     (arrancada con `CLAUDE_CYBER=1`). Un mensaje cyber nunca cae en el canal normal.
 *
 * Quién puede leer qué: una sesión normal solo lee `normal.jsonl` y nunca abre el
 * fichero cyber; una sesión cyber lee los dos (o solo uno, con `scope`).
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'

export type PeerChannel = 'normal' | 'cyber'
export type PeerScope = 'all' | PeerChannel

export type PeerParty = {
  address?: string
  pid?: number
  sessionId?: string
  name?: string
}

export type PeerLogEntry = {
  ts: number
  channel: PeerChannel
  from: PeerParty
  to: PeerParty
  text: string
}

/** Tamaño a partir del cual el fichero de un canal rota a `<canal>.1.jsonl`. */
const ROTATE_BYTES = 5 * 1024 * 1024
/** Cuánto del final de un fichero se lee al consultar el historial. */
const TAIL_BYTES = 512 * 1024
/** Texto máximo que se guarda por mensaje. */
const MAX_TEXT_CHARS = 20_000

export function isCyberSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CYBER === '1'
}

/** Canal de una conversación: cyber en cuanto uno de los dos extremos lo es. */
export function channelFor(senderCyber: boolean, receiverCyber: boolean): PeerChannel {
  return senderCyber || receiverCyber ? 'cyber' : 'normal'
}

/**
 * Canales que una sesión puede leer. Una sesión normal solo ve `normal`, pida lo que
 * pida; con `scope: 'cyber'` no ve nada. Una sesión cyber ve los dos o el que pida.
 */
export function visibleChannels(cyber: boolean, scope: PeerScope = 'all'): PeerChannel[] {
  if (!cyber) return scope === 'cyber' ? [] : ['normal']
  if (scope === 'all') return ['normal', 'cyber']
  return [scope]
}

export function getPeerLogDir(): string {
  return join(getClaudeConfigHomeDir(), 'peer-log')
}

function channelFile(dir: string, channel: PeerChannel): string {
  return join(dir, `${channel}.jsonl`)
}

/** Anota un mensaje en el fichero de su canal. Nunca lanza: el historial es accesorio. */
export function appendPeerLog(entry: PeerLogEntry, dir = getPeerLogDir()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const file = channelFile(dir, entry.channel)
    if (existsSync(file) && statSync(file).size > ROTATE_BYTES) {
      renameSync(file, join(dir, `${entry.channel}.1.jsonl`))
    }
    const line = JSON.stringify({ ...entry, text: entry.text.slice(0, MAX_TEXT_CHARS) })
    appendFileSync(file, line + '\n', { mode: 0o600 })
  } catch {
    // best effort
  }
}

/** Últimas líneas de un fichero JSONL (como mucho TAIL_BYTES del final). */
function readTailLines(file: string): string[] {
  if (!existsSync(file)) return []
  const size = statSync(file).size
  const start = Math.max(0, size - TAIL_BYTES)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  const lines = buf.toString('utf8').split('\n')
  // Si se empezó a mitad de fichero, la primera línea puede estar cortada.
  if (start > 0) lines.shift()
  return lines.filter(l => l.trim().length > 0)
}

function partyMatches(p: PeerParty, ref: string): boolean {
  const r = ref.toLowerCase()
  return (
    String(p.pid) === ref ||
    p.address?.toLowerCase() === r ||
    (r.length >= 4 && (p.sessionId?.toLowerCase().startsWith(r) ?? false)) ||
    (p.name?.toLowerCase().includes(r) ?? false)
  )
}

export type ReadPeerLogOptions = {
  /** La sesión que lee es cyber. */
  cyber: boolean
  scope?: PeerScope
  /** Solo conversaciones en las que participa este pid, session id (prefijo), nombre o dirección. */
  peer?: string
  limit?: number
  dir?: string
}

/** Últimos mensajes de los canales visibles, de más antiguo a más reciente. */
export function readPeerLog(opts: ReadPeerLogOptions): PeerLogEntry[] {
  const dir = opts.dir ?? getPeerLogDir()
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const entries: PeerLogEntry[] = []
  for (const channel of visibleChannels(opts.cyber, opts.scope)) {
    for (const line of readTailLines(channelFile(dir, channel))) {
      try {
        const e = JSON.parse(line) as PeerLogEntry
        // El canal lo manda el fichero, no el contenido: un registro mal puesto no cruza.
        if (typeof e.ts === 'number' && typeof e.text === 'string') {
          entries.push({ ...e, channel })
        }
      } catch {
        // línea corrupta: se salta
      }
    }
  }
  const peer = opts.peer?.trim()
  return entries
    .filter(e => !peer || partyMatches(e.from ?? {}, peer) || partyMatches(e.to ?? {}, peer))
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit)
}

function label(p: PeerParty): string {
  const who = p.name ?? (p.sessionId ? p.sessionId.slice(0, 8) : undefined)
  return [p.pid !== undefined ? `pid ${p.pid}` : undefined, who ? `"${who}"` : undefined]
    .filter(Boolean)
    .join(' ') || (p.address ?? 'desconocida')
}

/** Una cabecera y el texto por mensaje; los textos largos se recortan. */
export function formatPeerLog(entries: PeerLogEntry[], maxChars = 800): string {
  return entries
    .map(e => {
      const when = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19)
      const body =
        e.text.length > maxChars ? `${e.text.slice(0, maxChars)}… [+${e.text.length - maxChars} chars]` : e.text
      return `[${when}] [${e.channel}] ${label(e.from)} → ${label(e.to)}\n${body}`
    })
    .join('\n\n')
}
