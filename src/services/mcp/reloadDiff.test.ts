import { describe, expect, test } from 'bun:test'
import {
  diffMcpConfigs,
  formatMcpDiffNotice,
  formatMcpReloadReport,
  hasBlockingConfigErrors,
  isEmptyDiff,
} from './reloadDiff.js'
import type { ScopedMcpServerConfig } from './types.js'

const stdio = (command: string, scope: ScopedMcpServerConfig['scope'] = 'project'): ScopedMcpServerConfig =>
  ({ type: 'stdio', command, args: [], scope }) as ScopedMcpServerConfig

describe('diffMcpConfigs', () => {
  test('classifies added, removed, changed and unchanged', () => {
    const diff = diffMcpConfigs(
      [
        { name: 'keep', config: stdio('a') },
        { name: 'edit', config: stdio('b') },
        { name: 'gone', config: stdio('c') },
      ],
      { keep: stdio('a'), edit: stdio('b2'), fresh: stdio('d') },
    )
    expect(diff).toEqual({ added: ['fresh'], removed: ['gone'], changed: ['edit'], unchanged: ['keep'] })
  })

  test('scope moves do not count as a change', () => {
    const diff = diffMcpConfigs([{ name: 'x', config: stdio('a', 'project') }], { x: stdio('a', 'user') })
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toEqual(['x'])
  })

  test('claudeai and dynamic servers are never reported as removed', () => {
    const diff = diffMcpConfigs(
      [
        { name: 'net', config: stdio('a', 'claudeai') },
        { name: 'plug', config: stdio('a', 'dynamic') },
        { name: 'usr', config: stdio('a', 'user') },
      ],
      {},
    )
    expect(diff.removed).toEqual(['usr'])
  })
})

describe('formatting', () => {
  test('notice is short and empty when nothing changed', () => {
    const diff = { added: ['foo'], removed: ['baz'], changed: ['bar'], unchanged: ['k'] }
    expect(formatMcpDiffNotice(diff)).toBe('MCP: +foo, ~bar, -baz')
    expect(formatMcpDiffNotice({ added: [], removed: [], changed: [], unchanged: ['k'] })).toBe('')
    expect(isEmptyDiff(diff)).toBe(false)
  })

  test('report lists every group and warnings', () => {
    const out = formatMcpReloadReport({ added: ['a'], removed: [], changed: ['b'], unchanged: ['c'] }, ['boom'])
    expect(out).toContain('added: a')
    expect(out).toContain('changed: b')
    expect(out).toContain('unchanged: c')
    expect(out).toContain('warning: boom')
    expect(formatMcpReloadReport({ added: [], removed: [], changed: [], unchanged: [] })).toContain('no servers')
  })
})

describe('hasBlockingConfigErrors', () => {
  test('only fatal non-missing errors block', () => {
    const fatal = { message: 'MCP config is not a valid JSON', mcpErrorMetadata: { severity: 'fatal' } }
    const missing = { message: 'MCP config file not found: /x', mcpErrorMetadata: { severity: 'fatal' } }
    const warn = { message: 'w', mcpErrorMetadata: { severity: 'warning' } }
    expect(hasBlockingConfigErrors([fatal])).toBe(true)
    expect(hasBlockingConfigErrors([missing, warn])).toBe(false)
    expect(hasBlockingConfigErrors([])).toBe(false)
  })
})
