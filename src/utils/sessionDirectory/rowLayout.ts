/**
 * Maquetación de una fila del selector (pura), en la línea de `agentPanelRow.ts`:
 * origen, título que se trunca, directorio, cuenta:modelo y edad a la derecha.
 */

import { basename } from 'path'
import { ageOf, originLabel } from './rows.js'
import type { RowStatus, SessionRow } from './types.js'

export const STATUS_GLYPH: Record<RowStatus, string> = {
  waiting: '◐',
  busy: '●',
  idle: '○',
  done: '✓',
  failed: '✗',
  stopped: '■',
  lost: '?',
}

export type RowParts = {
  glyph: string
  origin: string
  title: string
  cwd: string
  who: string
  age: string
}

const ORIGIN_W = 7
const CWD_W = 16
const WHO_W = 18
const AGE_W = 4

/** Corta con `…` a `max` caracteres y rellena con espacios por la derecha hasta `max`. */
export function fit(s: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...s]
  const cut = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
  return cut + ' '.repeat(Math.max(0, max - [...cut].length))
}

/** Trozos de la fila para un ancho total `columns` (sin el puntero `❯ ` de la izquierda). */
export function layoutSessionRow(row: SessionRow, columns: number, now: number): RowParts {
  const who = [row.account, row.model].filter(Boolean).join(':') || row.harness
  const fixed = 2 + ORIGIN_W + 1 + CWD_W + 1 + WHO_W + 1 + AGE_W + 1
  const titleW = Math.max(12, columns - fixed)
  return {
    glyph: STATUS_GLYPH[row.status],
    origin: fit(originLabel(row), ORIGIN_W),
    title: fit(row.title, titleW),
    cwd: fit(row.cwd ? basename(row.cwd) : '', CWD_W),
    who: fit(who, WHO_W),
    age: row.lastActivity > 0 ? ageOf(row, now).padStart(AGE_W) : ''.padStart(AGE_W, ' '),
  }
}
