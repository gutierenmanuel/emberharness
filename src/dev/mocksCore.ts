// Parte pura del modo mock: validación del JSON de mocks y su traducción a
// tareas falsas. Sin efectos (ni fs, ni React, ni AppState) para poder
// probarla con `bun test`.

import type { BackgroundTaskState } from '../tasks/types.js'

export const MOCK_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const
export type MockPermissionMode = (typeof MOCK_PERMISSION_MODES)[number]

export type MocksState = {
  shells: number // 0-5 pastilla del pie
  monitors: number // 0-5
  agents: number // 0-5
  permissionMode: MockPermissionMode | null // null = no tocar
  spinner: { on: boolean; text: string }
  contextPct: number | null // 0-100, null = real
  notification: { text: string; seq: number } | null
  error: { text: string; seq: number } | null
  accounts: number // 0-12, para el bloque E (no se pinta aquí)
  models: number // 0-500, para el bloque E (no se pinta aquí)
}

export const EMPTY_MOCKS: MocksState = {
  shells: 0,
  monitors: 0,
  agents: 0,
  permissionMode: null,
  spinner: { on: false, text: '' },
  contextPct: null,
  notification: null,
  error: null,
  accounts: 0,
  models: 0,
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function int(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return Math.min(max, Math.max(min, Math.round(v)))
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function evento(v: unknown): { text: string; seq: number } | null {
  // Acepta "texto" o {text, seq}. El seq distingue repeticiones del mismo texto.
  if (typeof v === 'string') return v ? { text: v.slice(0, 500), seq: 0 } : null
  if (!isObj(v)) return null
  const text = str(v.text)
  return text ? { text, seq: int(v.seq, 0, Number.MAX_SAFE_INTEGER, 0) } : null
}

/** Valida un valor desconocido y devuelve siempre un MocksState completo. */
export function parseMocks(input: unknown): MocksState {
  if (!isObj(input)) return { ...EMPTY_MOCKS }
  const mode = input.permissionMode
  const sp = isObj(input.spinner) ? input.spinner : {}
  return {
    shells: int(input.shells, 0, 20, 0),
    monitors: int(input.monitors, 0, 20, 0),
    agents: int(input.agents, 0, 20, 0),
    permissionMode: (MOCK_PERMISSION_MODES as readonly unknown[]).includes(mode)
      ? (mode as MockPermissionMode)
      : null,
    spinner: { on: sp.on === true, text: str(sp.text, 120) },
    contextPct:
      typeof input.contextPct === 'number' && Number.isFinite(input.contextPct)
        ? int(input.contextPct, 0, 100, 0)
        : null,
    notification: evento(input.notification),
    error: evento(input.error),
    accounts: int(input.accounts, 0, 12, 0),
    models: int(input.models, 0, 500, 0),
  }
}

/** Parsea el texto de un fichero; JSON roto => null (conservar el estado previo). */
export function parseMocksText(text: string): MocksState | null {
  try {
    return parseMocks(JSON.parse(text))
  } catch {
    return null
  }
}

const MOCK_PREFIX = 'mock_'

type TaskBase = {
  id: string
  status: 'running'
  description: string
  startTime: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

function base(id: string, description: string, now: number): TaskBase {
  return {
    id,
    status: 'running',
    description,
    startTime: now,
    outputFile: `/dev/null`,
    outputOffset: 0,
    notified: false,
  }
}

/**
 * Traduce los contadores a tareas falsas con la forma de src/tasks/types.ts.
 * Sin procesos reales: shellCommand null, sin abortController.
 */
export function buildFakeTasks(
  m: Pick<MocksState, 'shells' | 'monitors' | 'agents'>,
  now: number,
): Record<string, BackgroundTaskState> {
  const out: Record<string, BackgroundTaskState> = {}
  for (let i = 1; i <= m.shells; i++) {
    const id = `${MOCK_PREFIX}sh${i}`
    out[id] = {
      ...base(id, `mock shell ${i}`, now),
      type: 'local_bash',
      command: `sleep 1000 # mock ${i}`,
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
      kind: 'bash',
    } as BackgroundTaskState
  }
  for (let i = 1; i <= m.monitors; i++) {
    const id = `${MOCK_PREFIX}mon${i}`
    out[id] = {
      ...base(id, `mock monitor ${i}`, now),
      type: 'local_bash',
      command: `tail -f /dev/null # mock ${i}`,
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
      kind: 'monitor',
    } as BackgroundTaskState
  }
  for (let i = 1; i <= m.agents; i++) {
    const id = `${MOCK_PREFIX}ag${i}`
    out[id] = {
      ...base(id, `mock agent ${i}`, now),
      type: 'local_agent',
      agentId: `${MOCK_PREFIX}agent${i}`,
      prompt: `Tarea falsa ${i} del modo mock`,
      agentType: 'general-purpose',
      retain: false,
      diskLoaded: false,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
    } as BackgroundTaskState
  }
  return out
}

export const isMockTaskId = (id: string): boolean => id.startsWith(MOCK_PREFIX)
