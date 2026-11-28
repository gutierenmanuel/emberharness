import { describe, expect, test } from 'bun:test'
import { agentModelSpec, layoutAgentRow, selectionHint, type AgentRowInput } from './agentPanelRow.js'

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

describe('agent rows always show name, account and resolved model', () => {
  test('agentModelSpec: routed agent shows its account; unrouted, the session account with the resolved id', () => {
    expect(agentModelSpec('zcode:glm-5.3-flash', { accountId: 'zcode', model: 'glm-5.3-flash' }, 'claude')).toBe('zcode:glm-5.3-flash')
    expect(agentModelSpec('claude-sonnet-5-5', null, 'claude')).toBe('claude:claude-sonnet-5-5')
    expect(agentModelSpec('claude:claude-haiku-4-5', { accountId: 'claude', model: 'claude-haiku-4-5' }, 'claude')).toBe('claude:claude-haiku-4-5')
    expect(agentModelSpec(undefined, null, 'claude')).toBeUndefined()
  })

  test('row format: name · cuenta:modelo · description, also for the session account', () => {
    const l = line({ ...base, label: 'lab-operator', model: 'zcode:glm-5.3-flash', description: 'Mapa mejoras NVIDIA' })
    expect(l.startsWith('  ◯ lab-operator · zcode:glm-5.3-flash · Mapa mejoras NVIDIA')).toBe(true)
    const same = line({ ...base, label: 'general-purpose', model: 'claude:claude-sonnet-5-5', description: 'Plan fork' })
    expect(same.startsWith('  ◯ general-purpose · claude:claude-sonnet-5-5 · Plan fork')).toBe(true)
  })

  test('the alias follows the agent type when it differs', () => {
    const l = line({ ...base, label: 'Explore', alias: 'buscador', model: 'claude:claude-haiku-4-5' })
    expect(l).toContain('◯ Explore (buscador) · claude:claude-haiku-4-5 · Count')
    expect(line({ ...base, label: 'Explore', alias: 'Explore', model: 'claude:x' })).not.toContain('(Explore)')
  })

  test('the account label is shown when it fits and dropped before the description is squeezed', () => {
    const wide = line({ ...base, label: 'lab-operator', model: 'zcode:glm-5.3-flash', accountLabel: 'Z.ai Coding', columns: 140 })
    expect(wide).toContain('lab-operator · zcode:glm-5.3-flash (Z.ai Coding) · Count .ts files in src/')
    const narrow = line({ ...base, label: 'lab-operator', model: 'zcode:glm-5.3-flash', accountLabel: 'Z.ai Coding', description: 'x'.repeat(200), columns: 90 })
    expect(narrow).not.toContain('Z.ai Coding')
  })

  test('only the description is truncated: name, account and model survive a narrow terminal', () => {
    const l = line({ ...base, label: 'lab-operator', model: 'zcode:glm-5.3-flash', description: 'y'.repeat(300), columns: 70 })
    expect(l.startsWith('  ◯ lab-operator · zcode:glm-5.3-flash · ')).toBe(true)
    expect(l).toContain('…')
    expect(w(l)).toBeLessThanOrEqual(68)
    expect(l.endsWith('7s · ↓ 16.9k tokens')).toBe(true)
  })
})
