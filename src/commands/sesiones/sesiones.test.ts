import { describe, expect, test } from 'bun:test'
import type { DirectoryInput, SessionRow } from '../../utils/sessionDirectory/types.js'
import { formatRow, suspendedConversations } from './sesiones.js'

const NOW = 1_000_000_000_000

const row = (over: Partial<SessionRow>): SessionRow => ({
  key: 'k',
  self: false,
  harness: 'fnharness',
  origin: 'kitty',
  status: 'idle',
  title: 'un título',
  lastActivity: NOW - 120_000,
  actions: [],
  ...over,
})

describe('formatRow', () => {
  test('origen, estado, título, cwd, cuenta:modelo y edad en una línea', () => {
    const line = formatRow(row({ cwd: '/w', account: 'groq', model: 'llama' }), NOW)
    expect(line).toMatch(/^ {2}kitty\s+idle\s+un título {2}\/w {2}groq:llama {2}2m$/)
  })

  test('la sesión actual lleva asterisco y la espera enseña su motivo', () => {
    const line = formatRow(row({ self: true, status: 'waiting', waitingFor: 'input needed' }), NOW)
    expect(line.startsWith('*')).toBe(true)
    expect(line).toContain('waiting(input needed)')
  })

  test('sin actividad registrada no inventa una edad', () => {
    expect(formatRow(row({ lastActivity: 0 }), NOW).endsWith('  -')).toBe(true)
  })

  test('un título largo se recorta a una línea', () => {
    const line = formatRow(row({ title: 'x'.repeat(200) }), NOW)
    expect(line.length).toBeLessThan(160)
    expect(line).toContain('…')
  })
})

describe('suspendedConversations', () => {
  const input = {
    elementConversations: [
      { agent: 'a', session: 's-viva', status: 'suspended', claudeSessionId: 'sid-1' },
      { agent: 'a', session: 's-dormida', status: 'suspended', claudeSessionId: 'sid-2' },
      { agent: 'a', session: 's-activa', status: 'active' },
    ],
  } as unknown as DirectoryInput

  test('solo las suspendidas que no corresponden a una fila viva', () => {
    const rows = [row({ sessionId: 'sid-1' })]
    expect(suspendedConversations(input, rows).map(c => c.session)).toEqual(['s-dormida'])
  })

  test('una fila en el mismo panel tmux también la tapa', () => {
    const rows = [row({ tmux: { socket: 'x', session: 's-dormida' } })]
    expect(suspendedConversations(input, rows).map(c => c.session)).toEqual(['s-viva'])
  })
})
