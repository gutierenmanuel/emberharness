import { expect, test } from 'bun:test'
import { noSuchToolMessage } from './toolGone.js'

test('plain tools keep the classic message', () => {
  expect(noSuchToolMessage('Foo')).toBe('No such tool available: Foo')
})

test('mcp tools explain the reload and name the server', () => {
  const m = noSuchToolMessage('mcp__fixture__echo')
  expect(m).toContain('No such tool available: mcp__fixture__echo')
  expect(m).toContain('"fixture"')
  expect(m).toContain('reloaded')
})
