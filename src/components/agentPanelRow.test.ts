import { describe, expect, test } from 'bun:test'
import { layoutAgentRow, selectionHint, type AgentRowInput } from './agentPanelRow.js'

const w = (s: string) => [...s].length
const cut = (s: string, max: number) => (w(s) <= max ? s : max <= 0 ? '' : [...s].slice(0, max - 1).join('') + '…')
const base: AgentRowInput = {
  label: 'Explore',
  description: 'Count .ts files in src/',
  selected: false,
  viewed: false,
  running: true,
  elapsed: '7s',
  tokens: '16.9k',
  columns: 120,
}
const line = (i: AgentRowInput) => {
  const p = layoutAgentRow(i, w, cut)
  return p.head + p.description + p.gap + p.right
}

describe('layoutAgentRow', () => {
  test('an agent on another account shows it after the label', () => {
    const l = line({ ...base, account: 'qwen36' })
    expect(l.startsWith('  ◯ Explore [qwen36]  Count .ts files in src/')).toBe(true)
    expect(w(l)).toBe(118)
  })
  test('idle row aligns time and tokens to the right edge', () => {
    const l = line(base)
    expect(l.startsWith('  ◯ Explore  Count .ts files in src/')).toBe(true)
    expect(l.endsWith('7s · ↓ 16.9k tokens')).toBe(true)
    expect(w(l)).toBe(118)
  })
  test('selected row uses the pointer and shows the stop hint', () => {
    const l = line({ ...base, selected: true })
    expect(l.startsWith('❯ ◯ Explore')).toBe(true)
    expect(l.endsWith('Enter to view · x to stop')).toBe(true)
  })
  test('viewed row uses a filled bullet and no hint', () => {
    const l = line({ ...base, selected: true, viewed: true })
    expect(l).toContain('● Explore')
    expect(l).not.toContain('Enter to view')
  })
  test('finished agent offers clear instead of stop', () => {
    expect(selectionHint(false, false)).toBe('Enter to view · x to clear')
  })
  test('long descriptions are truncated so the row never overflows', () => {
    const l = line({ ...base, description: 'x'.repeat(300), columns: 80 })
    expect(w(l)).toBeLessThanOrEqual(78)
    expect(l).toContain('…')
    expect(l.endsWith('7s · ↓ 16.9k tokens')).toBe(true)
  })
  test('queued messages and no tokens', () => {
    const l = line({ ...base, tokens: undefined, queued: 2 })
    expect(l.endsWith('7s · 2 queued')).toBe(true)
  })
})
