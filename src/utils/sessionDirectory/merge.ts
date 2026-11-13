/**
 * Fusión pura de las fuentes crudas del directorio de sesiones en filas `SessionRow`.
 *
 * Una sesión = una fila. Claves de fusión: sessionId (principal), pid (secundaria),
 * `tmux:<socket>/<sesion>` (terciaria). Reglas de origen, prioridad final:
 * element > bg > headless > kitty confirmado > tmux > headless (si nada encaja).
 * No toca disco, red ni procesos: todo llega en el `DirectoryInput`.
 */

import { actionsFor } from './actions.js'
import {
  ancestorChain,
  detectOrigin,
  findKittyWindow,
  findKittyWindowByRecord,
} from './origin.js'
import type {
  BgEntry,
  DirectoryInput,
  ElementConversation,
  ElementState,
  Harness,
  Origin,
  RegistryEntry,
  RowStatus,
  SessionRow,
  TmuxPane,
} from './types.js'

/** Cuántas sesiones cerradas se muestran en "Recientes". */
export const MAX_RECENT = 10

const PID_REUSE_OK = /cli|claude|fnharness|bun/i
const GROUP_RANK: Record<RowStatus, number> = {
  waiting: 0,
  busy: 1,
  idle: 2,
  done: 3,
  failed: 3,
  stopped: 3,
  lost: 3,
}

const tmuxKey = (socket: string, session: string): string => `${socket}/${session}`

function lastSegment(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}

/** Arnés de un registro: marca explícita, rasgos de Claude Code o el que declare la fuente. */
function harnessOfRecord(entry: RegistryEntry): Harness {
  const r = entry.record
  if (r.harness) return r.harness
  if (r.version !== undefined || r.peerProtocol !== undefined) return 'claude'
  if (lastSegment(entry.configDir).startsWith('.claude')) return 'claude'
  return entry.harness
}

/** Arnés de una sala de Element sin registro: por su directorio de configuración; sin él, Claude Code. */
function harnessOfConfigDir(configDir: string | undefined): Harness {
  if (!configDir) return 'claude'
  return lastSegment(configDir).startsWith('.claude') ? 'claude' : 'fnharness'
}

function maxTime(...values: Array<number | undefined>): number {
  let max = 0
  for (const v of values) if (v !== undefined && Number.isFinite(v) && v > max) max = v
  return max
}

function parseTime(s: string | undefined): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const t = v?.replace(/\s+/g, ' ').trim()
    if (t) return t
  }
  return undefined
}

function bgStatusToRow(status: BgEntry['status']): RowStatus {
  return status === 'running' ? 'busy' : status
}

export function mergeSessions(input: DirectoryInput): SessionRow[] {
  const { procs, transcripts } = input

  // Índices de tmux y Element.
  const panesByKey = new Map<string, TmuxPane>()
  const panesByPid = new Map<number, TmuxPane>()
  for (const p of input.tmuxPanes) {
    panesByKey.set(tmuxKey(p.socket, p.session), p)
    panesByPid.set(p.panePid, p)
  }
  const statesByKey = new Map<string, ElementState>()
  const statesBySession = new Map<string, ElementState>()
  const statesByFile = new Map<string, ElementState>()
  const statesBySid = new Map<string, ElementState>()
  for (const s of input.elementStates) {
    statesByKey.set(tmuxKey(s.socket, s.session), s)
    statesBySession.set(s.session, s)
    statesByFile.set(s.stateFile, s)
    if (s.sessionId) statesBySid.set(s.sessionId, s)
  }
  const livePane = (s: ElementState): TmuxPane | undefined =>
    panesByKey.get(tmuxKey(s.socket, s.session))

  const convFor = (sid: string | undefined, session: string | undefined, agent?: string) =>
    findConversation(input.elementConversations, sid, session, agent)

  // bg en marcha por sessionId (los terminados no cambian el origen de una sesión viva).
  const bgBySid = new Map<string, BgEntry>()
  for (const b of input.bg) {
    const prev = bgBySid.get(b.meta.sessionId)
    if (!prev || (b.status === 'running' && prev.status !== 'running')) {
      bgBySid.set(b.meta.sessionId, b)
    }
  }

  const rows = new Map<string, SessionRow>()
  const usedStates = new Set<string>()
  const usedTmux = new Set<string>()
  const isSelf = (pid: number | undefined, sid: string | undefined): boolean =>
    (pid !== undefined && pid === input.selfPid) ||
    (sid !== undefined && sid === input.selfSessionId)

  // ---- 1. Registros vivos --------------------------------------------------
  const entries = dedupeRegistry(input.registry).filter(e => {
    const cmd = procs[e.record.pid]?.cmdline
    return cmd === undefined || PID_REUSE_OK.test(cmd)
  })

  for (const entry of entries) {
    const rec = entry.record
    const pid = rec.pid
    const sid = rec.sessionId
    const env = procs[pid]?.env ?? {}
    const hint = detectOrigin({ env, kind: rec.kind, entrypoint: rec.entrypoint })
    const chain = ancestorChain(pid, procs)
    const ancestorPane = chain.map(p => panesByPid.get(p)).find((p): p is TmuxPane => !!p)

    // Sala de Element: por sessionId con panel vivo, por el panel ancestro, por el entorno o el registro.
    let state: ElementState | undefined
    const bySid = sid ? statesBySid.get(sid) : undefined
    if (bySid && livePane(bySid)) state = bySid
    if (!state && ancestorPane) state = statesByKey.get(tmuxKey(ancestorPane.socket, ancestorPane.session))
    if (!state && env.CLAUDE_TERM_SESSION) state = statesBySession.get(env.CLAUDE_TERM_SESSION)
    if (!state && rec.origin?.matrixStateFile) state = statesByFile.get(rec.origin.matrixStateFile)
    const isElement =
      state !== undefined || hint.origin === 'element' || rec.origin?.matrixStateFile !== undefined

    // Panel tmux de la fila.
    let tmux: SessionRow['tmux']
    const pane = ancestorPane ?? (state ? livePane(state) : undefined)
    if (pane) tmux = { socket: pane.socket, session: pane.session }
    else if (state) tmux = { socket: state.socket, session: state.session }
    else if (rec.origin?.tmuxSocket) {
      tmux = { socket: rec.origin.tmuxSocket, session: rec.origin.tmuxSession ?? '' }
    } else if (hint.tmuxSocket) tmux = { socket: hint.tmuxSocket, session: '' }

    const kittyWin = findKittyWindow(pid, procs, input.kittyWindows) ??
      findKittyWindowByRecord(rec.origin, input.kittyWindows)
    const bg = sid ? bgBySid.get(sid) : undefined

    let origin: Origin
    if (isElement) origin = 'element'
    else if (hint.origin === 'bg' || rec.kind === 'bg' || bg?.status === 'running') origin = 'bg'
    else if (hint.origin === 'headless') origin = 'headless'
    else if (kittyWin) origin = 'kitty'
    else if (tmux) origin = 'tmux'
    else origin = 'headless'

    if (state) usedStates.add(state.stateFile)
    if (tmux?.session) usedTmux.add(tmuxKey(tmux.socket, tmux.session))

    const conv = isElement
      ? convFor(sid, state?.session ?? env.CLAUDE_TERM_SESSION ?? tmux?.session, state?.agent)
      : undefined
    const tr = sid ? transcripts[sid] : undefined
    const status: RowStatus = rec.status ?? 'idle'
    const row: SessionRow = {
      key: sid ?? `pid:${pid}`,
      self: isSelf(pid, sid),
      harness: harnessOfRecord(entry),
      origin,
      status,
      ...(rec.waitingFor ? { waitingFor: rec.waitingFor } : {}),
      title:
        firstText(conv?.title, tr?.title, tr?.firstPrompt, rec.name, bg?.meta.prompt, tmux?.session) ??
        `pid ${pid}`,
      ...(firstText(rec.cwd, state?.workdir, conv?.workdir) !== undefined
        ? { cwd: rec.cwd ?? state?.workdir ?? conv?.workdir }
        : {}),
      ...(rec.account ? { account: rec.account } : {}),
      ...(rec.model ? { model: rec.model } : {}),
      lastActivity: maxTime(rec.updatedAt, tr?.lastModified, parseTime(conv?.lastActivity)),
      pid,
      ...(sid ? { sessionId: sid } : {}),
      ...(rec.messagingSocketPath ? { socket: rec.messagingSocketPath } : {}),
      ...(origin === 'kitty' && kittyWin
        ? { kitty: { listenOn: kittyWin.listenOn, windowId: kittyWin.windowId, focused: kittyWin.isFocused } }
        : {}),
      ...(tmux && (origin === 'element' || origin === 'tmux') ? { tmux } : {}),
      ...(conv?.roomId ? { room: conv.roomId } : {}),
      ...(bg ? { bgId: bg.meta.id } : {}),
      configDir: entry.configDir,
      actions: [],
    }
    rows.set(row.key, row)
  }

  // ---- 2. Salas de Element con panel vivo y sin registro ---------------------
  for (const state of input.elementStates) {
    if (usedStates.has(state.stateFile)) continue
    const pane = livePane(state)
    if (!pane) continue
    const tk = tmuxKey(state.socket, state.session)
    if (usedTmux.has(tk)) continue
    if (state.sessionId && rows.has(state.sessionId)) continue
    const conv = convFor(state.sessionId, state.session, state.agent)
    const tr = state.sessionId ? transcripts[state.sessionId] : undefined
    const sid = state.sessionId
    const key = sid ?? `tmux:${tk}`
    if (rows.has(key)) continue
    usedTmux.add(tk)
    const cwd = state.workdir ?? conv?.workdir
    rows.set(key, {
      key,
      self: isSelf(undefined, sid),
      harness: harnessOfConfigDir(state.configDir),
      origin: 'element',
      status: 'idle',
      title: firstText(conv?.title, tr?.title, tr?.firstPrompt, state.session) ?? state.session,
      ...(cwd ? { cwd } : {}),
      lastActivity: maxTime(tr?.lastModified, parseTime(conv?.lastActivity), parseTime(state.startedAt)),
      ...(sid ? { sessionId: sid } : {}),
      tmux: { socket: pane.socket, session: pane.session },
      ...(conv?.roomId ? { room: conv.roomId } : {}),
      ...(state.configDir ? { configDir: state.configDir } : {}),
      actions: [],
    })
  }

  // ---- 3. Sesiones bg ---------------------------------------------------------
  for (const b of bgBySid.values()) {
    const sid = b.meta.sessionId
    const existing = rows.get(sid)
    if (existing) {
      // Mismo sessionId que un registro vivo: una sola fila; conserva pid, socket y estado del registro.
      existing.bgId = b.meta.id
      continue
    }
    const tr = transcripts[sid]
    const running = b.status === 'running'
    rows.set(sid, {
      key: sid,
      self: isSelf(running ? b.meta.pid : undefined, sid),
      harness: 'fnharness',
      origin: 'bg',
      status: bgStatusToRow(b.status),
      title:
        firstText(tr?.title, tr?.firstPrompt, b.meta.prompt, `bg ${b.meta.id}`) ?? `bg ${b.meta.id}`,
      cwd: b.meta.cwd,
      account: b.meta.account,
      lastActivity: maxTime(b.meta.startedAt, b.meta.stoppedAt, tr?.lastModified),
      ...(running ? { pid: b.meta.pid } : {}),
      sessionId: sid,
      bgId: b.meta.id,
      configDir: b.configDir,
      actions: [],
    })
  }

  // ---- 4. Recientes: transcripts cerrados que no estén vivos -------------------
  const liveSids = new Set<string>()
  for (const r of rows.values()) if (r.sessionId) liveSids.add(r.sessionId)
  const seenRecent = new Set<string>()
  const recents = [...input.recent]
    .filter(r => !liveSids.has(r.sessionId) && r.sessionId !== input.selfSessionId)
    .sort((a, b) => b.lastModified - a.lastModified)
    .filter(r => !seenRecent.has(r.sessionId) && !!seenRecent.add(r.sessionId))
    .slice(0, MAX_RECENT)
  for (const r of recents) {
    const tr = transcripts[r.sessionId]
    rows.set(r.sessionId, {
      key: r.sessionId,
      self: false,
      harness: harnessOfConfigDir(r.configDir),
      origin: 'recent',
      status: 'done',
      title: firstText(tr?.title, r.title, tr?.firstPrompt) ?? `sesion ${r.sessionId.slice(0, 8)}`,
      ...(r.cwd ? { cwd: r.cwd } : {}),
      lastActivity: maxTime(r.lastModified, tr?.lastModified),
      sessionId: r.sessionId,
      configDir: r.configDir,
      actions: [],
    })
  }

  // ---- 5. Acciones y orden ------------------------------------------------------
  const out = [...rows.values()]
  for (const row of out) {
    const { actions, disabledActions } = actionsFor(row)
    row.actions = actions
    if (Object.keys(disabledActions).length > 0) row.disabledActions = disabledActions
  }
  out.sort(
    (a, b) =>
      GROUP_RANK[a.status] - GROUP_RANK[b.status] ||
      Number(b.self) - Number(a.self) ||
      b.lastActivity - a.lastActivity,
  )
  return out
}

/** Un registro por sessionId (gana el más reciente); los que no tienen sessionId se quedan tal cual. */
function dedupeRegistry(entries: RegistryEntry[]): RegistryEntry[] {
  const bySid = new Map<string, RegistryEntry>()
  const noSid: RegistryEntry[] = []
  for (const e of entries) {
    const sid = e.record.sessionId
    if (!sid) {
      noSid.push(e)
      continue
    }
    const prev = bySid.get(sid)
    if (!prev || (e.record.updatedAt ?? 0) >= (prev.record.updatedAt ?? 0)) bySid.set(sid, e)
  }
  return [...bySid.values(), ...noSid]
}

/** Conversación de Element: por claude_session_id; si no, por nombre de sesión tmux (y agente si se conoce). */
function findConversation(
  convs: ElementConversation[],
  sid: string | undefined,
  session: string | undefined,
  agent?: string,
): ElementConversation | undefined {
  if (sid) {
    const hit = convs.find(c => c.claudeSessionId === sid)
    if (hit) return hit
  }
  if (session) {
    return (
      convs.find(c => c.session === session && (!agent || c.agent === agent)) ??
      convs.find(c => c.session === session)
    )
  }
  return undefined
}
