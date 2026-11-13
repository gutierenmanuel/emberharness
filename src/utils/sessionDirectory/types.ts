/**
 * Tipos del directorio de sesiones de toda la máquina (selector de ←, `/sesiones`).
 *
 * El directorio se construye en dos pasos: `sources.ts` (impuro) lee cinco fuentes y
 * devuelve un `DirectoryInput` con datos crudos; `merge.ts` (puro) los funde en filas
 * `SessionRow`. Este fichero solo declara los tipos que comparten ambos lados, la
 * interfaz de las filas y las acciones disponibles. No tiene lógica ni efectos.
 */

import type { BgMeta, BgStatus } from '../../cli/bgCore.js'

/** Programa que corre la sesión. Element con `claude` y las salas de fnharness conviven. */
export type Harness = 'fnharness' | 'claude'

/** Dónde vive la sesión: de eso depende cómo se salta a ella. */
export type Origin = 'kitty' | 'tmux' | 'element' | 'headless' | 'bg' | 'recent'

/** Estado mostrado. `busy|waiting|idle` vienen del registro; el resto de bg o de transcripts cerrados. */
export type RowStatus = 'waiting' | 'busy' | 'idle' | 'done' | 'failed' | 'stopped' | 'lost'

/** Lo que se puede hacer con una fila. El primero de `actions` es el que ejecuta Enter. */
export type ActionId =
  | 'focus-kitty' // enfocar la ventana de kitty (kitty @ focus-window)
  | 'attach-tmux' // ceder esta terminal a `tmux attach`
  | 'resume-here' // relanzar este CLI con --resume (solo si la sesión no está viva)
  | 'fork-here' // relanzar con --resume <sid> --fork-session (sesión viva)
  | 'send-message' // sendToUdsSocket (solo fnharness con socket)
  | 'view-log' // cola del log de una bg
  | 'stop' // parar una bg en marcha

/** Datos de origen que cada sesión escribe en su propio `<pid>.json` (sessionRecord.ts). */
export type RecordOrigin = {
  kittyWindowId?: number
  kittyListenOn?: string
  tmuxSocket?: string
  tmuxSession?: string
  matrixStateFile?: string
  /** PID del lanzador bin/fnharness (FNHARNESS_LAUNCHER_PID), si lo hay. */
  launcherPid?: number
}

/** Contenido de `<config>/sessions/<pid>.json`, de fnharness o de Claude Code. */
export type RegistryRecord = {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: string
  entrypoint?: string
  messagingSocketPath?: string
  status?: 'busy' | 'idle' | 'waiting'
  waitingFor?: string
  updatedAt?: number
  name?: string
  /** Solo fnharness, lo escribe useSessionRecordSync. */
  account?: string
  model?: string
  origin?: RecordOrigin
  /** Solo fnharness: marca explícita del arnés. Claude Code escribe `version` y `peerProtocol`. */
  harness?: Harness
  version?: string
  peerProtocol?: number
}

/** Un registro vivo y de qué directorio de configuración salió. */
export type RegistryEntry = {
  harness: Harness
  configDir: string
  record: RegistryRecord
}

/** Lo que se sabe de un proceso por /proc: padre y entorno (vacío si no se pudo leer). */
export type ProcInfo = {
  ppid: number
  env: Record<string, string>
  cmdline?: string
}

/** Metadatos de un transcript (cabeza y cola), ya procesados. */
export type TranscriptInfo = {
  title?: string
  firstPrompt?: string
  lastModified?: number
  path?: string
}

/** Una sesión en segundo plano con su estado ya derivado. */
export type BgEntry = {
  meta: BgMeta
  status: BgStatus
  configDir: string
}

/** Estado de una sala de Element: `<state_dir>/<agente>/<sesion>.json`. */
export type ElementState = {
  agent: string
  stateFile: string
  /** Nombre de la sesión tmux (`pc-a-c-1113-1558`). */
  session: string
  /** Socket tmux (`matrixterm`), el valor de `tmux -L`. */
  socket: string
  sessionId?: string
  workdir?: string
  configDir?: string
  startedAt?: string
}

/** Entrada de `conversations-<agente>.json`. */
export type ElementConversation = {
  agent: string
  roomId?: string
  session: string
  title?: string
  claudeSessionId?: string
  workdir?: string
  /** `active`, `suspended`... */
  status?: string
  lastActivity?: string
}

/** Un panel de `tmux -L <socket> list-panes -a`. */
export type TmuxPane = {
  socket: string
  session: string
  panePid: number
}

/** Una ventana de kitty (de `kitty @ --to <listenOn> ls`). */
export type KittyWindow = {
  listenOn: string
  windowId: number
  /** PID del proceso raíz de la ventana (el shell). */
  pid: number
  /** PIDs de los procesos en primer plano de la ventana. */
  foregroundPids: number[]
  cwd?: string
  title?: string
  isFocused: boolean
}

/** Transcript cerrado de ~/.fnharness/projects, para el grupo "Recientes". */
export type RecentTranscript = {
  sessionId: string
  cwd?: string
  title?: string
  lastModified: number
  configDir: string
}

/** Todo lo que leen las fuentes, sin fundir. Entrada de `mergeSessions`. */
export type DirectoryInput = {
  now: number
  /** PID y sessionId de esta sesión (se marca `self`); undefined fuera de una sesión. */
  selfPid?: number
  selfSessionId?: string
  registry: RegistryEntry[]
  bg: BgEntry[]
  elementStates: ElementState[]
  elementConversations: ElementConversation[]
  tmuxPanes: TmuxPane[]
  kittyWindows: KittyWindow[]
  /** Por pid: padre y entorno (para detectar el origen y subir hasta una ventana kitty). */
  procs: Record<number, ProcInfo>
  /** Por sessionId: título y última modificación del transcript. */
  transcripts: Record<string, TranscriptInfo>
  recent: RecentTranscript[]
}

/** Una fila del selector y de `/sesiones list --json`. */
export type SessionRow = {
  /** Clave estable: sessionId, o `pid:<n>`, o `tmux:<socket>/<sesion>`, o `bg:<id>`. */
  key: string
  self: boolean
  harness: Harness
  origin: Origin
  status: RowStatus
  waitingFor?: string
  title: string
  cwd?: string
  account?: string
  model?: string
  /** Epoch ms: máximo entre updatedAt, mtime del transcript y last_activity de Matrix. */
  lastActivity: number
  pid?: number
  sessionId?: string
  socket?: string
  kitty?: { listenOn: string; windowId: number; focused: boolean }
  tmux?: { socket: string; session: string }
  /** Sala de Element (room_id). */
  room?: string
  /** Id corto de una sesión bg. */
  bgId?: string
  configDir?: string
  actions: ActionId[]
  /** Acciones que se muestran apagadas, con el motivo. */
  disabledActions?: Partial<Record<ActionId, string>>
}
