import { describe, expect, test } from 'bun:test'
import { actionsFor, canResumeInPlace, defaultAction, FORK_CROSS_HARNESS_REASON } from './actions.js'
import type { SessionRow } from './types.js'

function row(over: Partial<SessionRow>): SessionRow {
  return {
    key: 'k',
    self: false,
    harness: 'fnharness',
    origin: 'headless',
    status: 'idle',
    title: 't',
    lastActivity: 0,
    actions: [],
    ...over,
  }
}

describe('actionsFor', () => {
  test('self no ofrece acciones', () => {
    const r = actionsFor(row({ self: true, origin: 'kitty', sessionId: 's', pid: 1 }))
    expect(r.actions).toEqual([])
    expect(r.disabledActions).toEqual({})
  })

  test('kitty fnharness: enfocar y bifurcar', () => {
    expect(actionsFor(row({ origin: 'kitty', sessionId: 's', pid: 1 })).actions).toEqual(['focus-kitty', 'fork-here'])
  })

  test('kitty fnharness sin sessionId: solo enfocar', () => {
    expect(actionsFor(row({ origin: 'kitty', pid: 1 })).actions).toEqual(['focus-kitty'])
  })

  test('element/tmux fnharness: attach y fork', () => {
    for (const origin of ['element', 'tmux'] as const) {
      expect(actionsFor(row({ origin, sessionId: 's' })).actions).toEqual(['attach-tmux', 'fork-here'])
    }
  })

  test('element/tmux claude: fork-here apagado con motivo', () => {
    const r = actionsFor(row({ origin: 'element', harness: 'claude', sessionId: 's' }))
    expect(r.actions).toEqual(['attach-tmux'])
    expect(r.disabledActions['fork-here']).toBe(FORK_CROSS_HARNESS_REASON)
    expect(FORK_CROSS_HARNESS_REASON).toContain('no cruza de arnes')
  })

  test('headless fnharness vivo: fork y send-message si hay socket', () => {
    expect(actionsFor(row({ pid: 9, sessionId: 's', socket: '/tmp/x.sock' })).actions).toEqual(['fork-here', 'send-message'])
    expect(actionsFor(row({ pid: 9, sessionId: 's' })).actions).toEqual(['fork-here'])
    expect(actionsFor(row({ harness: 'claude', pid: 9, sessionId: 's' })).actions).toEqual([])
  })

  test('bg en marcha: ver log y parar', () => {
    for (const status of ['busy', 'idle', 'waiting'] as const) {
      expect(actionsFor(row({ origin: 'bg', status, pid: 5 })).actions).toEqual(['view-log', 'stop'])
    }
  })

  test('bg terminada: reanudar y ver log', () => {
    for (const status of ['done', 'failed', 'stopped', 'lost'] as const) {
      expect(actionsFor(row({ origin: 'bg', status, sessionId: 's' })).actions).toEqual(['resume-here', 'view-log'])
    }
  })

  test('recent: reanudar', () => {
    expect(actionsFor(row({ origin: 'recent', status: 'done', sessionId: 's' })).actions).toEqual(['resume-here'])
  })

  test('una sesión viva nunca ofrece resume-here', () => {
    const vivas = [
      row({ origin: 'kitty', pid: 1, sessionId: 's' }),
      row({ origin: 'tmux', pid: 1, sessionId: 's' }),
      row({ origin: 'element', sessionId: 's', tmux: { socket: 'a', session: 'b' } }),
      row({ origin: 'headless', pid: 1, sessionId: 's', socket: 'x' }),
      row({ origin: 'bg', status: 'busy', pid: 1, sessionId: 's' }),
    ]
    for (const r of vivas) expect(actionsFor(r).actions).not.toContain('resume-here')
  })

  test('defaultAction es la primera acción', () => {
    expect(defaultAction(row({ actions: ['focus-kitty', 'fork-here'] }))).toBe('focus-kitty')
    expect(defaultAction(row({ actions: [] }))).toBeUndefined()
  })
})

describe('canResumeInPlace', () => {
  test('false si una fila viva (pid, tmux o bg en marcha) tiene ese sessionId', () => {
    expect(canResumeInPlace('s', [row({ sessionId: 's', pid: 1 })])).toBe(false)
    expect(canResumeInPlace('s', [row({ origin: 'element', sessionId: 's', tmux: { socket: 'a', session: 'b' } })])).toBe(false)
    expect(canResumeInPlace('s', [row({ origin: 'bg', status: 'busy', sessionId: 's' })])).toBe(false)
  })

  test('true si nadie vivo lo tiene', () => {
    expect(canResumeInPlace('s', [])).toBe(true)
    expect(canResumeInPlace('s', [row({ sessionId: 'otra', pid: 1 })])).toBe(true)
    expect(canResumeInPlace('s', [row({ origin: 'bg', status: 'done', sessionId: 's' })])).toBe(true)
    expect(canResumeInPlace('s', [row({ origin: 'recent', status: 'done', sessionId: 's' })])).toBe(true)
  })
})
