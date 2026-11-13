/**
 * Acciones disponibles por fila (puro).
 *
 * Regla dura: una sesión viva nunca ofrece `resume-here`, solo `fork-here`, porque dos
 * procesos no pueden escribir el mismo `.jsonl`. `canResumeInPlace` es la comprobación
 * que usa quien ejecute la acción para no cruzar esa línea.
 */

import type { ActionId, SessionRow } from './types.js'

export type ActionSet = {
  actions: ActionId[]
  disabledActions: Partial<Record<ActionId, string>>
}

export const FORK_CROSS_HARNESS_REASON =
  'una conversacion no cruza de arnes: se reanuda desde Matrix'

/** Estados de una bg que sigue en marcha (el registro vivo aporta idle/waiting). */
const FINISHED = new Set(['done', 'failed', 'stopped', 'lost'])

/** Una fila bg cuyo proceso sigue vivo. */
export function isRunningBg(row: SessionRow): boolean {
  return row.origin === 'bg' && !FINISHED.has(row.status)
}

/** ¿La fila tiene un proceso (o panel tmux, o bg en marcha) que podría escribir su transcript? */
export function isAlive(row: SessionRow): boolean {
  return row.pid !== undefined || row.tmux !== undefined || isRunningBg(row)
}

export function actionsFor(row: SessionRow): ActionSet {
  const actions: ActionId[] = []
  const disabledActions: Partial<Record<ActionId, string>> = {}
  if (row.self) return { actions, disabledActions }

  const forkable = row.harness === 'fnharness' && row.sessionId !== undefined

  switch (row.origin) {
    case 'kitty':
      actions.push('focus-kitty')
      if (forkable) actions.push('fork-here')
      else if (row.harness === 'claude') disabledActions['fork-here'] = FORK_CROSS_HARNESS_REASON
      break
    case 'element':
    case 'tmux':
      actions.push('attach-tmux')
      if (forkable) actions.push('fork-here')
      else if (row.harness === 'claude') disabledActions['fork-here'] = FORK_CROSS_HARNESS_REASON
      break
    case 'headless':
      if (row.harness === 'fnharness' && row.pid !== undefined) {
        if (row.sessionId !== undefined) actions.push('fork-here')
        if (row.socket) actions.push('send-message')
      }
      break
    case 'bg':
      if (isRunningBg(row)) actions.push('view-log', 'stop')
      else actions.push('resume-here', 'view-log')
      break
    case 'recent':
      actions.push('resume-here')
      break
  }
  return { actions, disabledActions }
}

/** La acción que ejecuta Enter: la primera de la lista. */
export function defaultAction(row: SessionRow): ActionId | undefined {
  return row.actions[0]
}

/**
 * ¿Se puede reanudar `sessionId` en el sitio (`--resume` sin `--fork-session`)?
 * No si alguna fila viva (con pid, con panel tmux o bg en marcha) tiene ese id.
 */
export function canResumeInPlace(sessionId: string, rows: SessionRow[]): boolean {
  return !rows.some(r => r.sessionId === sessionId && isAlive(r))
}
