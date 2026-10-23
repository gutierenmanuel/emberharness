// Modo mock de fnharness (bloque G del ROADMAP).
//
// Decisión: NO va tras un feature flag de build. Funciona con el ./cli normal
// para no mantener dos binarios; el coste sin la variable es una comparación
// con process.env al arrancar. Si FNHARNESS_MOCKS no está definida, nada de lo
// de aquí se activa (installMocks devuelve sin tocar nada y useMockState
// devuelve siempre el mismo estado vacío).
//
// Con FNHARNESS_MOCKS=<ruta.json> se vigila el fichero (fs.watch + relectura
// con debounce) y cada cambio se aplica en caliente. El último estado queda en
// globalThis.__FNHARNESS_MOCKS__ (lo leerá el bloque E para «N cuentas · M
// modelos»).

import { existsSync, readFileSync, watch } from 'fs'
import { dirname } from 'path'
import { useSyncExternalStore } from 'react'
import type { Store } from '../state/store.js'
import {
  buildFakeTasks,
  EMPTY_MOCKS,
  isMockTaskId,
  parseMocksText,
  type MocksState,
} from './mocksCore.js'

declare global {
  // eslint-disable-next-line no-var
  var __FNHARNESS_MOCKS__: MocksState | undefined
}

const DEBOUNCE_MS = 60
const NOTIFICATION_MS = 8000

export const mocksEnabled = (): boolean => !!process.env.FNHARNESS_MOCKS

let current: MocksState = EMPTY_MOCKS
const listeners = new Set<() => void>()
let installed = false

/** Estado actual (EMPTY_MOCKS si el modo mock está apagado). */
export const getMocks = (): MocksState => current

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Hook React: re-renderiza al cambiar los mocks. Sin variable no se suscribe a nada útil. */
export function useMockState(): MocksState {
  return useSyncExternalStore(subscribe, getMocks, getMocks)
}

function setMocks(next: MocksState): void {
  current = next
  globalThis.__FNHARNESS_MOCKS__ = next
  for (const l of listeners) l()
}

type AnyStore = Store<any>

function applyToAppState(store: AnyStore, m: MocksState): void {
  const now = Date.now()
  store.setState((prev: any) => {
    // Tareas: quita las mock previas y añade las nuevas (conserva las reales).
    const tasks: Record<string, unknown> = {}
    for (const [id, t] of Object.entries(prev.tasks ?? {})) {
      if (!isMockTaskId(id)) tasks[id] = t
    }
    Object.assign(tasks, buildFakeTasks(m, now))
    const next: any = { ...prev, tasks }
    if (m.permissionMode) {
      next.toolPermissionContext = {
        ...prev.toolPermissionContext,
        mode: m.permissionMode,
      }
    }
    return next
  })
}

let lastNotifSeq: string | null = null
function applyNotification(store: AnyStore, m: MocksState): void {
  const n = m.notification
  const sig = n ? `${n.seq}:${n.text}` : null
  if (!n || sig === lastNotifSeq) return
  lastNotifSeq = sig
  // useNotifications solo procesa la cola al añadir o al montar, así que se
  // fija `current` directamente y se limpia con un temporizador propio.
  const key = `fnharness-mock-notification-${n.seq}`
  store.setState((prev: any) => ({
    ...prev,
    notifications: {
      ...prev.notifications,
      current: { key, text: n.text, priority: 'immediate' },
    },
  }))
  setTimeout(() => {
    store.setState((prev: any) =>
      prev.notifications.current?.key === key
        ? { ...prev, notifications: { ...prev.notifications, current: null } }
        : prev,
    )
  }, NOTIFICATION_MS).unref?.()
}

function readFile(path: string): MocksState | null {
  try {
    if (!existsSync(path)) return null
    return parseMocksText(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Único punto de enganche: se llama desde AppStateProvider al crear el store.
 * Sin FNHARNESS_MOCKS no hace nada.
 */
export function installMocks(store: AnyStore): void {
  const path = process.env.FNHARNESS_MOCKS
  if (!path) return

  // Puede haber varios AppStateProvider en vida del proceso (diálogos de
  // arranque y luego el REPL): se aplica al store más reciente.
  if (store !== activeStore) {
    activeStore = store
    lastNotifSeq = null
    if (installed) applyAll(store, current)
  }
  if (installed) return
  installed = true

  const load = () => {
    const m = readFile(path)
    if (!m) return // fichero ausente o JSON a medias: conservar el estado previo
    setMocks(m)
    if (activeStore) applyAll(activeStore, m)
  }
  load()

  // Se vigila el directorio: el servidor puede reescribir por rename atómico.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Sin filtrar por nombre: Bun informa de un rename atómico con el nombre
    // origen (mocks.json.tmp), no con el destino. Releer es barato y va con debounce.
    const w = watch(dirname(path), () => {
      clearTimeout(timer)
      timer = setTimeout(load, DEBOUNCE_MS)
    })
    w.unref?.()
  } catch {
    // sin watch no hay recarga en caliente, pero la carga inicial ya se hizo
  }
}

let activeStore: AnyStore | null = null

function applyAll(store: AnyStore, m: MocksState): void {
  applyToAppState(store, m)
  applyNotification(store, m)
}
