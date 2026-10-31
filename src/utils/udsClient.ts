import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { createConnection } from 'net'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { SessionKind, SessionStatus } from './concurrentSessions.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'

export type LiveSession = {
  pid: number
  sessionId?: string
  cwd?: string
  kind?: SessionKind
  name?: string
  status?: SessionStatus
  waitingFor?: string
  startedAt?: number
  updatedAt?: number
  entrypoint?: string
  messagingSocketPath?: string
  parentMessagingSocketPath?: string
}

/**
 * Live sessions from the `<config dir>/sessions/<pid>.json` registry written by
 * registerSession(). Stale files (dead pid) are skipped. Used by `--continue`
 * to avoid picking a transcript that a running bg session is still writing,
 * and by ListPeers / `/peers` to find sessions that can receive messages.
 */
export async function listAllLiveSessions(): Promise<LiveSession[]> {
  const dir = join(getClaudeConfigHomeDir(), 'sessions')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue
    try {
      const s = JSON.parse(await readFile(join(dir, f), 'utf8')) as LiveSession
      if (isProcessRunning(s.pid)) out.push(s)
    } catch {
      // unreadable or half-written: skip
    }
  }
  return out
}

export type Peer = LiveSession & {
  /** Address to pass as SendMessage `to` (`uds:<socket>`). */
  address: string
  isSelf: boolean
  /** This peer launched the current session. */
  isParent: boolean
  /** The current session launched this peer. */
  isChild: boolean
}

/** Live sessions with a reachable inbox socket, oldest first. */
export async function listPeers(): Promise<Peer[]> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const uds =
    require('./udsMessaging.js') as typeof import('./udsMessaging.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const mine = uds.getUdsMessagingSocketPath()
  const parent = uds.getParentUdsSocketPath()
  const sessions = await listAllLiveSessions()
  return sessions
    .filter(s => s.messagingSocketPath && existsSync(s.messagingSocketPath))
    .map(s => ({
      ...s,
      address: `uds:${s.messagingSocketPath}`,
      isSelf: s.pid === process.pid,
      isParent: parent !== undefined && s.messagingSocketPath === parent,
      isChild: mine !== undefined && s.parentMessagingSocketPath === mine,
    }))
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}

/**
 * Resolve a peer reference to its socket path. Accepts `uds:<path>`, a bare
 * socket path, `parent`, a pid, a session id (or a prefix of at least 4
 * characters) or a session name.
 */
export async function resolvePeerSocket(ref: string): Promise<string> {
  const r = ref.trim().replace(/^peer:/, '')
  if (r.startsWith('uds:')) return r.slice(4)
  if (r.startsWith('/')) return r
  const peers = (await listPeers()).filter(p => !p.isSelf)
  if (r === 'parent') {
    const parent = peers.find(p => p.isParent)
    if (parent) return parent.messagingSocketPath!
    throw new Error('this session has no live parent session')
  }
  const matches = peers.filter(
    p =>
      String(p.pid) === r ||
      p.sessionId === r ||
      (r.length >= 4 && p.sessionId?.startsWith(r)) ||
      (p.name !== undefined && p.name.toLowerCase() === r.toLowerCase()),
  )
  if (matches.length === 1) return matches[0]!.messagingSocketPath!
  if (matches.length === 0) {
    throw new Error(`no live session matches "${ref}" (use ListPeers)`)
  }
  throw new Error(
    `"${ref}" is ambiguous: ${matches.map(p => p.pid).join(', ')} — use the pid`,
  )
}

/**
 * Deliver a plain-text message to another session's inbox socket. Resolves
 * once the receiver has queued it; rejects on refusal, timeout or no listener.
 */
export async function sendToUdsSocket(
  socketPath: string,
  text: string,
  timeoutMs = 5000,
): Promise<void> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const uds =
    require('./udsMessaging.js') as typeof import('./udsMessaging.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const mine = uds.getUdsMessagingSocketPath()
  if (mine && socketPath === mine) {
    throw new Error('that address is this session; pick another peer')
  }
  const payload = {
    type: 'message',
    text,
    from: mine ? `uds:${mine}` : undefined,
    pid: process.pid,
    sessionId: getSessionId(),
    cwd: getOriginalCwd(),
    name: process.env.CLAUDE_CODE_SESSION_NAME,
  }
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(socketPath)
    let buf = ''
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error(`no answer from ${socketPath} in ${timeoutMs} ms`)),
      timeoutMs,
    )
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify(payload) + '\n'))
    conn.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      try {
        const res = JSON.parse(buf.slice(0, nl)) as { ok?: boolean; error?: string }
        finish(res.ok ? undefined : new Error(res.error ?? 'refused'))
      } catch {
        finish(new Error('malformed answer from peer'))
      }
    })
    conn.on('error', e => finish(e))
    conn.on('close', () => finish(new Error('peer closed the connection without answering')))
  })
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

/** One line per peer: pid, session id, name, status, cwd and address. */
export function formatPeers(peers: Peer[], now = Date.now()): string {
  return peers
    .map(p => {
      const tags = [
        p.isSelf ? 'this session' : undefined,
        p.isParent ? 'parent' : undefined,
        p.isChild ? 'child' : undefined,
      ].filter(Boolean)
      const parts = [
        `pid ${p.pid}`,
        p.sessionId ? `session ${p.sessionId}` : undefined,
        p.name ? `name "${p.name}"` : undefined,
        p.kind && p.kind !== 'interactive' ? p.kind : undefined,
        p.status
          ? p.status === 'waiting' && p.waitingFor
            ? `waiting for ${p.waitingFor}`
            : p.status
          : undefined,
        p.startedAt ? `up ${formatAge(now - p.startedAt)}` : undefined,
        p.cwd ? `cwd ${p.cwd}` : undefined,
      ].filter(Boolean)
      const tagText = tags.length ? ` [${tags.join(', ')}]` : ''
      return `- ${parts.join(' · ')}${tagText}\n  to: "${p.address}"`
    })
    .join('\n')
}
