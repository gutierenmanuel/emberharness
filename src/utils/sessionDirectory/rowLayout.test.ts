import { describe, expect, test } from 'bun:test'
import { fit, layoutSessionRow } from './rowLayout.js'
import type { SessionRow } from './types.js'

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  key: 'k',
  self: false,
  harness: 'fnharness',
  origin: 'kitty',
  status: 'busy',
  title: 'Plan session switcher',
  cwd: '/home/u/fn_registry/apps/fnharness',
  account: 'qwen36',
  lastActivity: 1_000_000 - 40_000,
  actions: [],
  ...over,
})

describe('rowLayout', () => {
  test('fit trunca con elipsis y rellena', () => {
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('ab', 4)).toBe('ab  ')
  })

  test('los trozos tienen ancho fijo y la edad sale a la derecha', () => {
    const p = layoutSessionRow(row(), 120, 1_000_000)
    expect(p.glyph).toBe('●')
    expect(p.origin).toBe('kitty  ')
    expect(p.cwd.trim()).toBe('fnharness')
    expect(p.who.trim()).toBe('qwen36')
    expect(p.age).toBe(' 40s')
    expect([...p.title].length).toBe(120 - (2 + 7 + 1 + 16 + 1 + 18 + 1 + 4 + 1))
  })

  test('sin actividad conocida no pinta una edad absurda y sin cuenta enseña el arnés', () => {
    const p = layoutSessionRow(row({ lastActivity: 0, account: undefined, self: true }), 100, 5)
    expect(p.age.trim()).toBe('')
    expect(p.who.trim()).toBe('fnharness')
    expect(p.origin.trim()).toBe('esta')
  })
})
