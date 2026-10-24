import { describe, expect, test } from 'bun:test'
import {
  createMcpToolsTracker,
  diffMcpToolSets,
  formatMcpToolsChanged,
  groupMcpTools,
} from './toolsDelta.js'

describe('groupMcpTools', () => {
  test('groups by server, keeps double underscores in tool names, ignores non-mcp', () => {
    const g = groupMcpTools(['mcp__a__y', 'mcp__a__x', 'mcp__b__q__r', 'Bash', 'mcp__c'])
    expect([...g.entries()]).toEqual([
      ['a', ['x', 'y']],
      ['b', ['q__r']],
    ])
  })
})

describe('diffMcpToolSets', () => {
  test('reports added, removed and fully gone/new servers', () => {
    const prev = groupMcpTools(['mcp__a__x', 'mcp__a__y', 'mcp__gone__t'])
    const next = groupMcpTools(['mcp__a__x', 'mcp__a__z', 'mcp__new__t'])
    expect(diffMcpToolSets(prev, next)).toEqual([
      { server: 'a', added: ['z'], removed: ['y'] },
      { server: 'gone', added: [], removed: ['t'] },
      { server: 'new', added: ['t'], removed: [] },
    ])
  })
  test('identical sets give no changes', () => {
    const s = groupMcpTools(['mcp__a__x'])
    expect(diffMcpToolSets(s, groupMcpTools(['mcp__a__x']))).toEqual([])
  })
})

describe('tracker', () => {
  test('first observation is a silent baseline; later only real changes are reported', () => {
    const t = createMcpToolsTracker()
    expect(t.observe('c1', ['mcp__a__x'])).toEqual([])
    expect(t.observe('c1', ['mcp__a__x'])).toEqual([])
    expect(t.observe('c1', ['mcp__a__x', 'mcp__a__y'])).toEqual([{ server: 'a', added: ['y'], removed: [] }])
    // consumed: asking again with the same set reports nothing
    expect(t.observe('c1', ['mcp__a__x', 'mcp__a__y'])).toEqual([])
  })
  test('a new conversation (clear/compact) re-baselines without a notice', () => {
    const t = createMcpToolsTracker()
    t.observe('c1', ['mcp__a__x'])
    expect(t.observe('c2', ['mcp__b__z'])).toEqual([])
    expect(t.observe('c2', [])).toEqual([{ server: 'b', added: [], removed: ['z'] }])
  })
  test('flapping within one turn collapses to the net difference', () => {
    const t = createMcpToolsTracker()
    t.observe('c1', ['mcp__a__x'])
    // x vanished and came back between two turns: nothing to say
    expect(t.observe('c1', ['mcp__a__x'])).toEqual([])
  })
})

test('formatMcpToolsChanged names every tool fully qualified', () => {
  const text = formatMcpToolsChanged([{ server: 'a', added: ['z'], removed: ['y'] }])
  expect(text).toContain('mcp__a__z')
  expect(text).toContain('no longer available: mcp__a__y')
})
