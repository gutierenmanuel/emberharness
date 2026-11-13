/**
 * Filas del selector: grupos, filtro, edad y resumen (puro).
 *
 * `mergeSessions` ya entrega las filas ordenadas; aquí solo se agrupan para pintarlas
 * (las bg y las recientes tienen su propio grupo sea cual sea su estado) y se conserva
 * el orden de entrada dentro de cada grupo.
 */

import { isAlive } from './actions.js'
import type { SessionRow } from './types.js'

export type GroupLabel = 'Esperando' | 'Trabajando' | 'En espera' | 'Segundo plano' | 'Recientes'

export type DirectoryEntry =
  | { type: 'header'; label: GroupLabel; count: number }
  | { type: 'row'; row: SessionRow }

/** Orden de los grupos en pantalla. */
export const GROUP_ORDER: GroupLabel[] = [
  'Esperando',
  'Trabajando',
  'En espera',
  'Segundo plano',
  'Recientes',
]

export function groupOf(row: SessionRow): GroupLabel {
  if (row.origin === 'bg') return 'Segundo plano'
  if (row.origin === 'recent') return 'Recientes'
  if (row.status === 'waiting') return 'Esperando'
  if (row.status === 'busy') return 'Trabajando'
  return 'En espera'
}

/** Texto en el que busca el filtro: `titulo cwd account:model origen harness`. */
function haystack(row: SessionRow): string {
  return [
    row.title,
    row.cwd ?? '',
    `${row.account ?? ''}:${row.model ?? ''}`,
    row.origin,
    row.harness,
  ]
    .join(' ')
    .toLowerCase()
}

/** Todas las palabras de `query` (sin distinguir mayúsculas) deben aparecer en la fila. */
export function matchesQuery(row: SessionRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = haystack(row)
  return words.every(w => hay.includes(w))
}

/** Cabeceras (solo de grupos no vacíos) intercaladas con las filas que pasan el filtro. */
export function buildEntries(rows: SessionRow[], query: string): DirectoryEntry[] {
  const buckets = new Map<GroupLabel, SessionRow[]>()
  for (const row of rows) {
    if (!matchesQuery(row, query)) continue
    const g = groupOf(row)
    const list = buckets.get(g)
    if (list) list.push(row)
    else buckets.set(g, [row])
  }
  const entries: DirectoryEntry[] = []
  for (const label of GROUP_ORDER) {
    const list = buckets.get(label)
    if (!list || list.length === 0) continue
    entries.push({ type: 'header', label, count: list.length })
    for (const row of list) entries.push({ type: 'row', row })
  }
  return entries
}

/** `12s`, `2m`, `3h`, `2d`. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function ageOf(row: SessionRow, now: number): string {
  return formatAge(now - row.lastActivity)
}

/** Resumen de cabecera, p. ej. `9 vivas · 2 esperan respuesta · 1 sala de Element en tmux`. */
export function summaryLine(rows: SessionRow[]): string {
  const alive = rows.filter(isAlive)
  const waiting = alive.filter(r => r.status === 'waiting').length
  const element = alive.filter(r => r.origin === 'element').length
  const parts: string[] = []
  if (alive.length > 0) parts.push(`${alive.length} ${alive.length === 1 ? 'viva' : 'vivas'}`)
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'espera' : 'esperan'} respuesta`)
  if (element > 0) {
    parts.push(`${element} ${element === 1 ? 'sala' : 'salas'} de Element en tmux`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'sin sesiones vivas'
}

export type OriginLabel = 'kitty' | 'element' | 'tmux' | 'bg' | 'head' | 'esta' | 'rec'

export function originLabel(row: SessionRow): OriginLabel {
  if (row.self) return 'esta'
  switch (row.origin) {
    case 'kitty':
      return 'kitty'
    case 'element':
      return 'element'
    case 'tmux':
      return 'tmux'
    case 'bg':
      return 'bg'
    case 'recent':
      return 'rec'
    default:
      return 'head'
  }
}
