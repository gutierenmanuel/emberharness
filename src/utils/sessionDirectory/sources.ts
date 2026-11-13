/**
 * Fuentes del directorio de sesiones de toda la máquina (parte impura).
 *
 * `readDirectoryInput` lee los registros `sessions/<pid>.json` de varios
 * directorios de configuración, las sesiones bg, el estado de Element, los
 * paneles de tmux, las ventanas de kitty, /proc y los transcripts, y devuelve
 * datos crudos (`DirectoryInput`). `merge.ts` (puro) los funde en filas. Cada
 * fuente tolera fallos y tiene un tope de 300 ms; el resultado completo se
 * cachea 2 s para que el selector pueda refrescar sin coste.
 */

import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { parseSessionInfoFromLite } from '../listSessionsImpl.js'
import {
  readSessionLite,
  resolveSessionFilePath,
  sanitizePath,
} from '../sessionStoragePortable.js'
import { readProcs } from './procReader.js'
import { candidateConfigDirs, readRegistryEntries } from './registryReader.js'
import {
  kittySocketDir,
  listKittyWindows,
  listTmuxPanes,
  matrixStateDir,
  readElement,
} from './terminals.js'
import type {
  BgEntry,
  DirectoryInput,
  ElementConversation,
  ElementState,
  RecentTranscript,
  RegistryEntry,
  SessionRow,
  TranscriptInfo,
} from './types.js'

/** Tope de cada fuente. */
export const SOURCE_TIMEOUT_MS = 300
/** Vida de la caché del resultado completo. */
export const CACHE_TTL_MS = 2000
/** Cuántos transcripts cerrados se ofrecen en "Recientes". */
export const RECENT_LIMIT = 10

export type SourceOptions = {
  /** Salta la caché de 2 s (el selector la usa al abrirse). */
  noCache?: boolean
  /** Tope por fuente; por defecto 300 ms. */
  timeoutMs?: number
}

/** Resuelve con `fallback` si `p` tarda más de `ms` o falla. */
async function guard<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// bg
// ---------------------------------------------------------------------------

async function readBg(): Promise<BgEntry[]> {
  const { listBgSessions, statusOf } = await import('../../cli/bg.js')
  const configDir = getClaudeConfigHomeDir()
  return listBgSessions().map(meta => ({ meta, status: statusOf(meta), configDir }))
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** Caché por ruta: solo se vuelve a leer un transcript si cambió su mtime. */
const transcriptCache = new Map<string, { mtimeMs: number; info: TranscriptInfo }>()
/** sessionId -> ruta ya localizada (se revalida con el stat de cada lectura). */
const transcriptPaths = new Map<string, string>()

async function statMtime(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path)
    return s.size > 0 ? s.mtimeMs : undefined
  } catch {
    return undefined
  }
}

/** Localiza `<sessionId>.jsonl` en los directorios de configuración, mirando antes el proyecto del cwd. */
async function findTranscriptPath(
  sessionId: string,
  cwd: string | undefined,
  configDirs: string[],
  projectListing: Map<string, Promise<string[]>>,
): Promise<string | undefined> {
  const known = transcriptPaths.get(sessionId)
  if (known && (await statMtime(known)) !== undefined) return known
  const file = `${sessionId}.jsonl`
  if (cwd) {
    for (const dir of configDirs) {
      const p = join(dir, 'projects', sanitizePath(cwd), file)
      if (await statMtime(p)) return p
    }
  }
  // Sin cwd (o sin acierto): se recorren los proyectos de cada directorio.
  for (const dir of configDirs) {
    const projects = join(dir, 'projects')
    let names = projectListing.get(projects)
    if (!names) {
      names = readdir(projects).catch(() => [] as string[])
      projectListing.set(projects, names)
    }
    const found = await Promise.all(
      (await names).map(async n => {
        const p = join(projects, n, file)
        return (await statMtime(p)) ? p : undefined
      }),
    )
    const hit = found.find(p => p !== undefined)
    if (hit) return hit
  }
  // Último recurso: el resolutor general (también mira worktrees hermanos).
  const viaResolver = await resolveSessionFilePath(sessionId, cwd).catch(() => undefined)
  return viaResolver?.filePath
}

/** Título, primer prompt y mtime de un transcript, con caché por mtime. */
async function readTranscriptInfo(sessionId: string, path: string): Promise<TranscriptInfo | undefined> {
  const mtimeMs = await statMtime(path)
  if (mtimeMs === undefined) return undefined
  const cached = transcriptCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.info
  const lite = await readSessionLite(path)
  if (!lite) return undefined
  const parsed = parseSessionInfoFromLite(sessionId, lite)
  const info: TranscriptInfo = {
    title: parsed?.customTitle ?? parsed?.summary,
    firstPrompt: parsed?.firstPrompt,
    lastModified: lite.mtime,
    path,
  }
  transcriptCache.set(path, { mtimeMs, info })
  transcriptPaths.set(sessionId, path)
  return info
}

type TranscriptWanted = { sessionId: string; cwd?: string }

async function readTranscripts(
  wanted: TranscriptWanted[],
  extraConfigDirs: string[],
): Promise<Record<string, TranscriptInfo>> {
  const byId = new Map<string, TranscriptWanted>()
  for (const w of wanted) if (!byId.has(w.sessionId) || (w.cwd && !byId.get(w.sessionId)!.cwd)) byId.set(w.sessionId, w)
  const configDirs = [...new Set([...(await candidateConfigDirs()), ...extraConfigDirs])]
  const listing = new Map<string, Promise<string[]>>()
  const out: Record<string, TranscriptInfo> = {}
  await Promise.all(
    [...byId.values()].map(async ({ sessionId, cwd }) => {
      const path = await findTranscriptPath(sessionId, cwd, configDirs, listing)
      if (!path) return
      const info = await readTranscriptInfo(sessionId, path)
      if (info) out[sessionId] = info
    }),
  )
  return out
}

/** Los `RECENT_LIMIT` transcripts más recientes del directorio de configuración actual. */
async function readRecent(): Promise<RecentTranscript[]> {
  const configDir = getClaudeConfigHomeDir()
  const projects = join(configDir, 'projects')
  const names = await readdir(projects).catch(() => [] as string[])
  const perProject = await Promise.all(
    names.map(async n => {
      const files = (await readdir(join(projects, n)).catch(() => [] as string[])).filter(f =>
        f.endsWith('.jsonl'),
      )
      return Promise.all(
        files.map(async f => {
          const path = join(projects, n, f)
          const mtimeMs = await statMtime(path)
          return mtimeMs === undefined ? null : { path, sessionId: f.slice(0, -6), mtimeMs }
        }),
      )
    }),
  )
  const newest = perProject
    .flat()
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, RECENT_LIMIT)
  const recents = await Promise.all(
    newest.map(async f => {
      const lite = await readSessionLite(f.path)
      if (!lite) return null
      const parsed = parseSessionInfoFromLite(f.sessionId, lite)
      if (!parsed) return null // sidechain o sin nada que enseñar
      return {
        sessionId: f.sessionId,
        cwd: parsed.cwd,
        title: parsed.customTitle ?? parsed.summary,
        lastModified: lite.mtime,
        configDir,
      } satisfies RecentTranscript
    }),
  )
  return recents.filter((r): r is RecentTranscript => r !== null)
}

// ---------------------------------------------------------------------------
// Lectura completa
// ---------------------------------------------------------------------------

async function collect(opts: SourceOptions): Promise<DirectoryInput> {
  const ms = opts.timeoutMs ?? SOURCE_TIMEOUT_MS
  const now = Date.now()

  // Fase 1: fuentes independientes, en paralelo.
  const [registry, bg, element, kittyWindows, recent] = await Promise.all([
    guard<RegistryEntry[]>(readRegistryEntries(), ms, []),
    guard<BgEntry[]>(readBg(), ms, []),
    guard(readElement(matrixStateDir()), ms, {
      states: [] as ElementState[],
      conversations: [] as ElementConversation[],
    }),
    guard(listKittyWindows(kittySocketDir(), ms), ms, []),
    guard(readRecent(), ms, []),
  ])

  // Fase 2: tmux (necesita los sockets de Element y de los registros), procesos y transcripts.
  // El entorno de cada proceso se lee siempre, aunque el registro traiga `origin`: el
  // fundidor usa CLAUDE_TERM_SESSION y KITTY_* de ahí, y leerlo cuesta microsegundos.
  const sockets = new Set<string>()
  for (const s of element.states) sockets.add(s.socket)
  for (const e of registry) if (e.record.origin?.tmuxSocket) sockets.add(e.record.origin.tmuxSocket)
  const tmuxPanes = (
    await Promise.all([...sockets].map(s => guard(listTmuxPanes(s, ms), ms, [])))
  ).flat()

  const startPids = [...registry.map(e => e.record.pid), ...tmuxPanes.map(p => p.panePid)]
  const wanted: TranscriptWanted[] = [
    ...registry.flatMap(e => (e.record.sessionId ? [{ sessionId: e.record.sessionId, cwd: e.record.cwd }] : [])),
    ...bg.map(b => ({ sessionId: b.meta.sessionId, cwd: b.meta.cwd })),
    ...element.states.flatMap(s => (s.sessionId ? [{ sessionId: s.sessionId, cwd: s.workdir }] : [])),
  ]
  const extraConfigDirs = element.states.flatMap(s => (s.configDir ? [s.configDir] : []))
  const [procs, transcripts] = await Promise.all([
    guard(readProcs(startPids), ms, {}),
    guard(readTranscripts(wanted, extraConfigDirs), ms, {}),
  ])

  return {
    now,
    selfPid: process.pid,
    selfSessionId: safeSessionId(),
    registry,
    bg,
    elementStates: element.states,
    elementConversations: element.conversations,
    tmuxPanes,
    kittyWindows,
    procs,
    transcripts,
    recent,
  }
}

function safeSessionId(): string | undefined {
  try {
    return getSessionId()
  } catch {
    return undefined
  }
}

let cache: { key: string; at: number; value: Promise<DirectoryInput> } | undefined

/**
 * Datos crudos de las cinco fuentes. Cacheado 2 s (por directorio de
 * configuración y HOME, para que los tests aislados no se pisen); `noCache`
 * fuerza una lectura nueva.
 */
export function readDirectoryInput(opts: SourceOptions = {}): Promise<DirectoryInput> {
  const key = `${getClaudeConfigHomeDir()}|${homedir()}|${process.env.MATRIX_TERMINALS_STATE_DIR ?? ''}|${process.env.FNHARNESS_KITTY_SOCKET_DIR ?? ''}`
  const t = Date.now()
  if (!opts.noCache && cache && cache.key === key && t - cache.at < CACHE_TTL_MS) {
    return cache.value
  }
  const value = collect(opts)
  const mine = { key, at: t, value }
  cache = mine
  // Una lectura fallida no se queda en la caché.
  value.catch(() => {
    if (cache === mine) cache = undefined
  })
  return value
}

/** Filas ya fundidas: lo que pintan el selector y `/sesiones`. */
export async function loadSessionRows(opts: SourceOptions = {}): Promise<SessionRow[]> {
  const [input, { mergeSessions }] = await Promise.all([
    readDirectoryInput(opts),
    import('./merge.js'),
  ])
  return mergeSessions(input)
}
