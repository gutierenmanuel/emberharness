/**
 * Ejecuta una acción del selector sobre una fila. Es la única pieza que une la UI
 * con los saltos (`jump/*`), el socket de mensajes y las bg; la UI solo muestra el
 * mensaje que devuelve.
 */

import { listBgSessions, stopBgSession } from '../../cli/bg.js'
import { sendToUdsSocket } from '../../utils/udsClient.js'
import { errorMessage } from '../../utils/errors.js'
import { focusKittyWindow } from '../../utils/sessionDirectory/jump/kittyFocus.js'
import { resumeHere } from '../../utils/sessionDirectory/jump/resumeHere.js'
import { attachTmux } from '../../utils/sessionDirectory/jump/tmuxAttach.js'
import type { ActionId, SessionRow } from '../../utils/sessionDirectory/types.js'

export type ActionOutcome = {
  ok: boolean
  message: string
  /** Comando que la persona puede lanzar a mano si la acción no pudo hacerlo. */
  manualCommand?: string
  /** El selector debe cerrarse (la acción ya movió el foco a otra parte). */
  close?: boolean
}

export const ACTION_LABEL: Record<ActionId, string> = {
  'focus-kitty': 'Enfocar su ventana de kitty',
  'attach-tmux': 'Adjuntar aquí (tmux; Ctrl+B d para volver)',
  'resume-here': 'Reanudar aquí',
  'fork-here': 'Bifurcar aquí (--fork-session; no toca la original)',
  'send-message': 'Enviar mensaje…',
  'view-log': 'Ver el log',
  stop: 'Parar',
}

/** Acciones que cierran esta conversación y la sustituyen: piden confirmación en el detalle. */
export function replacesThisSession(action: ActionId): boolean {
  return action === 'resume-here' || action === 'fork-here'
}

export async function runAction(
  row: SessionRow,
  action: ActionId,
  ctx: { rows: SessionRow[]; text?: string },
): Promise<ActionOutcome> {
  try {
    switch (action) {
      case 'focus-kitty': {
        const r = await focusKittyWindow(row)
        return { ...r, close: r.ok }
      }
      case 'attach-tmux': {
        const r = await attachTmux(row)
        return { ...r, close: false }
      }
      case 'resume-here':
      case 'fork-here': {
        const r = await resumeHere(row, action === 'fork-here' ? 'fork' : 'resume', { allRows: ctx.rows })
        return { ...r, close: false }
      }
      case 'send-message': {
        if (!row.socket) return { ok: false, message: 'esta sesión no tiene socket de mensajes' }
        if (!ctx.text?.trim()) return { ok: false, message: 'mensaje vacío' }
        await sendToUdsSocket(row.socket, ctx.text.trim())
        return { ok: true, message: 'mensaje enviado' }
      }
      case 'stop': {
        const meta = listBgSessions().find(m => m.id === row.bgId)
        if (!meta) return { ok: false, message: 'no encuentro la sesión bg' }
        await stopBgSession(meta)
        return { ok: true, message: `sesión ${meta.id} detenida` }
      }
      case 'view-log':
        return { ok: true, message: '' }
    }
  } catch (e) {
    return { ok: false, message: errorMessage(e) }
  }
}
