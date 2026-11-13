import type { LocalCommandCall } from '../../types/command.js'
import { ageOf, formatAge, originLabel } from '../../utils/sessionDirectory/rows.js'
import { mergeSessions } from '../../utils/sessionDirectory/merge.js'
import { readDirectoryInput } from '../../utils/sessionDirectory/sources.js'
import type {
  DirectoryInput,
  ElementConversation,
  SessionRow,
} from '../../utils/sessionDirectory/types.js'

const USAGE =
  'Uso: /sesiones [list] [--json] [--todas]\n' +
  '  list      lista las sesiones de toda la máquina (es lo predeterminado)\n' +
  '  --json    imprime un array JSON con las filas, sin duplicados\n' +
  '  --todas   añade las conversaciones de Element suspendidas'

const MAX_TITLE = 60

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** `cuenta:modelo`, solo lo que se conozca. */
function accountModel(row: SessionRow): string {
  return [row.account, row.model].filter(Boolean).join(':')
}

/** Una línea por sesión: origen, estado, título, cwd, cuenta:modelo y edad. */
export function formatRow(row: SessionRow, now: number): string {
  const mark = row.self ? '*' : ' '
  const status = row.status === 'waiting' && row.waitingFor ? `waiting(${row.waitingFor})` : row.status
  const parts = [
    `${mark} ${originLabel(row).padEnd(7)}`,
    status.padEnd(8),
    clip(row.title || '(sin título)', MAX_TITLE),
    row.cwd ?? '-',
    accountModel(row) || '-',
    // Una sesión sin actividad registrada (lastActivity 0) no tiene edad que enseñar.
    row.lastActivity > 0 ? ageOf(row, now) : '-',
  ]
  return parts.join('  ')
}

/** Conversaciones de Element suspendidas que no corresponden a ninguna fila viva. */
export function suspendedConversations(
  input: DirectoryInput,
  rows: SessionRow[],
): ElementConversation[] {
  return input.elementConversations.filter(
    c =>
      c.status === 'suspended' &&
      !rows.some(
        r =>
          (c.claudeSessionId !== undefined && r.sessionId === c.claudeSessionId) ||
          (r.tmux !== undefined && r.tmux.session === c.session),
      ),
  )
}

function formatConversation(c: ElementConversation, now: number): string {
  const last = c.lastActivity ? Date.parse(c.lastActivity) : NaN
  return [
    `  ${'element'.padEnd(7)}`,
    'suspended'.padEnd(8),
    clip(c.title || c.session, MAX_TITLE),
    c.workdir ?? '-',
    c.agent,
    Number.isNaN(last) ? '-' : formatAge(now - last),
  ].join('  ')
}

export const call: LocalCommandCall = async args => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const flags = new Set(words.filter(w => w.startsWith('--')))
  const rest = words.filter(w => !w.startsWith('--'))
  const unknown = [...flags].filter(f => f !== '--json' && f !== '--todas')
  if (unknown.length > 0 || rest.length > 1 || (rest.length === 1 && rest[0] !== 'list')) {
    return { type: 'text', value: USAGE }
  }

  const input = await readDirectoryInput()
  const rows = mergeSessions(input)

  if (flags.has('--json')) {
    return { type: 'text', value: JSON.stringify(rows, null, 2) }
  }

  const lines = rows.length === 0 ? ['No hay sesiones en esta máquina.'] : rows.map(r => formatRow(r, input.now))
  if (flags.has('--todas')) {
    const suspended = suspendedConversations(input, rows)
    if (suspended.length > 0) {
      lines.push('', `Conversaciones de Element suspendidas (${suspended.length}):`)
      lines.push(...suspended.map(c => formatConversation(c, input.now)))
    }
  }
  return { type: 'text', value: lines.join('\n') }
}
