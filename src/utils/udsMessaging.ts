/**
 * UDS inbox: each fnharness session listens on a Unix domain socket so other
 * sessions on the same machine can drop messages into its prompt queue.
 *
 * Wire protocol (one request per connection): the client writes one JSON line
 * `{"type":"message","text":"...","from":"uds:<sender socket>",...}` and the
 * server answers one JSON line `{"ok":true}` (or `{"ok":false,"error":"..."}`)
 * before closing. The message is enqueued as a meta prompt wrapped in
 * `<cross-session-message from="...">`, which the receiver drains at its next
 * tool round (or starts a turn with, when idle).
 */
import { chmodSync, mkdirSync, unlinkSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { CROSS_SESSION_MESSAGE_TAG } from '../constants/xml.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { enqueue } from './messageQueueManager.js'
import { appendPeerLog, channelFor, isCyberSession } from './peerLog.js'
import {
  applySessionConfig,
  buildConfirmRequestText,
  getSessionConfigHost,
  isSessionConfigEnabled,
  readSessionConfig,
} from './sessionConfig.js'

/** Largest request accepted from a peer (1 MiB). */
const MAX_REQUEST_BYTES = 1024 * 1024

export type UdsInboundMessage = {
  type: 'message'
  text: string
  /** Sender address (`uds:<socket>`); the receiver copies it as `to` to reply. */
  from?: string
  pid?: number
  sessionId?: string
  cwd?: string
  name?: string
  /** El emisor es una sesión cyber (`CLAUDE_CYBER=1`); decide el canal del historial. */
  cyber?: boolean
}

/**
 * Petición de control: cambia un ajuste de esta sesión (ver sessionConfig.ts).
 * `{"type":"control","op":"model","value":"sonnet"}`; `op:"get"` lee el estado.
 */
export type UdsControlRequest = {
  type: 'control'
  op: string
  value?: unknown
  from?: string
}

export type UdsControlReply = {
  ok: boolean
  applied?: boolean
  needsConfirm?: boolean
  error?: string
  from?: unknown
  to?: unknown
  state?: Record<string, unknown>
}

let server: Server | null = null
let socketPath: string | undefined
let onEnqueue: (() => void) | null = null

/** Socket of the session that launched this one, if it was another session. */
let parentSocketPath: string | undefined

export function getDefaultUdsSocketPath(): string {
  return join(tmpdir(), 'fnharness-socks', `${process.pid}.sock`)
}

export function getUdsMessagingSocketPath(): string | undefined {
  return socketPath
}

export function getParentUdsSocketPath(): string | undefined {
  return parentSocketPath
}

/** Headless (-p / SDK) mode: kick the query loop when a message lands. */
export function setOnEnqueue(cb: (() => void) | null): void {
  onEnqueue = cb
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Wrap a peer message so the model knows who sent it and how to answer. */
export function wrapCrossSessionMessage(msg: UdsInboundMessage): string {
  const attrs: string[] = [`from="${escapeAttr(msg.from ?? 'unknown')}"`]
  if (msg.pid !== undefined) attrs.push(`pid="${msg.pid}"`)
  if (msg.sessionId) attrs.push(`session="${escapeAttr(msg.sessionId)}"`)
  if (msg.name) attrs.push(`name="${escapeAttr(msg.name)}"`)
  if (msg.cwd) attrs.push(`cwd="${escapeAttr(msg.cwd)}"`)
  // A body cannot close the wrapper early and smuggle text outside it.
  const closing = `</${CROSS_SESSION_MESSAGE_TAG}>`
  const body = msg.text.split(closing).join(`<\\/${CROSS_SESSION_MESSAGE_TAG}>`)
  return `<${CROSS_SESSION_MESSAGE_TAG} ${attrs.join(' ')}>\n${body}\n${closing}`
}

/** Validate a decoded request; returns the message or an error string. */
export function parseInboundRequest(raw: string): UdsInboundMessage | UdsControlRequest | string {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return 'invalid JSON'
  }
  if (typeof data !== 'object' || data === null) return 'expected an object'
  const d = data as Record<string, unknown>
  if (d.type === 'control') {
    if (typeof d.op !== 'string' || d.op.length === 0) return 'op must be a non-empty string'
    return { type: 'control', op: d.op, value: d.value, from: typeof d.from === 'string' ? d.from : undefined }
  }
  if (d.type !== 'message') return `unsupported type: ${String(d.type)}`
  if (typeof d.text !== 'string' || d.text.trim().length === 0) {
    return 'text must be a non-empty string'
  }
  return {
    type: 'message',
    text: d.text,
    from: typeof d.from === 'string' ? d.from : undefined,
    pid: typeof d.pid === 'number' ? d.pid : undefined,
    sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
    cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
    name: typeof d.name === 'string' ? d.name : undefined,
    cyber: typeof d.cyber === 'boolean' ? d.cyber : undefined,
  }
}

/**
 * Anota en el historial un mensaje que acaba de entrar. Va al canal cyber si el
 * emisor o esta sesión lo son; nunca lanza.
 */
function recordInbound(msg: UdsInboundMessage): void {
  appendPeerLog({
    ts: Date.now(),
    channel: channelFor(msg.cyber === true, isCyberSession()),
    from: { address: msg.from, pid: msg.pid, sessionId: msg.sessionId, name: msg.name },
    to: {
      address: socketPath ? `uds:${socketPath}` : undefined,
      pid: process.pid,
      sessionId: getSessionId(),
      name: process.env.CLAUDE_CODE_SESSION_NAME,
    },
    text: msg.text,
  })
}

export function deliverInboundMessage(msg: UdsInboundMessage): void {
  enqueue({
    mode: 'prompt',
    value: wrapCrossSessionMessage(msg),
    priority: 'next',
    isMeta: true,
    origin: { kind: 'peer', from: msg.from },
    skipSlashCommands: true,
  } as Parameters<typeof enqueue>[0])
  onEnqueue?.()
}

/**
 * Atiende una petición de control. Lo que exige confirmación de la persona
 * (subir permisos, cambiar de perfil) nunca se aplica aquí: se encola un mensaje
 * meta para que la sesión receptora lo pregunte, y la respuesta lleva needsConfirm.
 */
export async function handleControlRequest(req: UdsControlRequest): Promise<UdsControlReply> {
  if (!isSessionConfigEnabled()) return { ok: false, error: 'control disabled (FNHARNESS_SESSION_CONFIG != 1)' }
  const host = getSessionConfigHost()
  if (req.op === 'get') {
    if (!host) return { ok: false, error: 'session not ready' }
    return { ok: true, applied: false, needsConfirm: false, state: readSessionConfig(host.getAppState()) }
  }
  const r = await applySessionConfig({ op: req.op, value: req.value, origin: 'socket', confirmed: false, from: req.from }, host)
  if (r.ok && r.needsConfirm) {
    deliverInboundMessage({ type: 'message', text: buildConfirmRequestText(r, req.from), from: req.from })
  }
  return { ok: r.ok, applied: r.applied, needsConfirm: r.needsConfirm, error: r.error, from: r.from, to: r.to }
}

function handleConnection(conn: Socket): void {
  let buf = ''
  let done = false
  const reply = (payload: { ok: boolean; error?: string } & Partial<UdsControlReply>) => {
    if (done) return
    done = true
    conn.end(JSON.stringify(payload) + '\n')
  }
  conn.setEncoding('utf8')
  conn.setTimeout(10_000, () => conn.destroy())
  conn.on('error', () => {})
  conn.on('data', (chunk: string) => {
    if (done) return
    buf += chunk
    if (buf.length > MAX_REQUEST_BYTES) {
      reply({ ok: false, error: 'message too large' })
      return
    }
    const nl = buf.indexOf('\n')
    if (nl === -1) return
    const parsed = parseInboundRequest(buf.slice(0, nl))
    if (typeof parsed === 'string') {
      reply({ ok: false, error: parsed })
      return
    }
    if (parsed.type === 'control') {
      handleControlRequest(parsed).then(reply, e => reply({ ok: false, error: errorMessage(e) }))
      return
    }
    try {
      deliverInboundMessage(parsed)
      recordInbound(parsed)
      reply({ ok: true })
    } catch (e) {
      reply({ ok: false, error: errorMessage(e) })
    }
  })
}

/**
 * Bind the inbox socket and export it as $CLAUDE_CODE_MESSAGING_SOCKET so
 * hooks, child processes and the session registry see it. A socket already
 * inherited in that variable belongs to the session that launched this one:
 * it is kept as the parent address ($CLAUDE_CODE_PARENT_MESSAGING_SOCKET).
 */
export async function startUdsMessaging(
  path: string,
  { isExplicit }: { isExplicit: boolean },
): Promise<void> {
  if (process.platform === 'win32' || server) return
  const inherited = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  if (inherited && inherited !== path) {
    parentSocketPath = inherited
    process.env.CLAUDE_CODE_PARENT_MESSAGING_SOCKET = inherited
  }
  try {
    if (!isExplicit) {
      const dir = join(tmpdir(), 'fnharness-socks')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
    }
    try {
      unlinkSync(path)
    } catch {
      // nothing stale to remove
    }
    const srv = createServer(handleConnection)
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(path, () => {
        srv.off('error', reject)
        resolve()
      })
    })
    try {
      chmodSync(path, 0o600)
    } catch {
      // best effort: the directory is already 0700
    }
    srv.unref()
    server = srv
    socketPath = path
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = path
    registerCleanup(async () => {
      server?.close()
      server = null
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
    })
    logForDebugging(`[udsMessaging] listening on ${path}`)
  } catch (e) {
    // Never advertise the parent's socket as ours.
    if (process.env.CLAUDE_CODE_MESSAGING_SOCKET === inherited) {
      delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
    }
    logForDebugging(`[udsMessaging] could not bind ${path}: ${errorMessage(e)}`)
  }
}
