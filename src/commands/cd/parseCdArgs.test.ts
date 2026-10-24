import { describe, expect, test } from 'bun:test'
import { parseCdArgs } from './parseCdArgs.js'

describe('parseCdArgs', () => {
  test('rejects empty arguments', () => {
    expect(parseCdArgs('', '/w', '/h').ok).toBe(false)
    expect(parseCdArgs('   ', '/w', '/h').ok).toBe(false)
    expect(parseCdArgs(undefined, '/w', '/h').ok).toBe(false)
    expect(parseCdArgs('""', '/w', '/h').ok).toBe(false)
  })
  test('keeps absolute paths', () => {
    expect(parseCdArgs('/a/b/../c', '/w', '/h')).toEqual({ ok: true, path: '/a/c' })
  })
  test('resolves relative paths against cwd', () => {
    expect(parseCdArgs('../x', '/w/y', '/h')).toEqual({ ok: true, path: '/w/x' })
  })
  test('expands ~ and ~/', () => {
    expect(parseCdArgs('~', '/w', '/h')).toEqual({ ok: true, path: '/h' })
    expect(parseCdArgs('~/p', '/w', '/h')).toEqual({ ok: true, path: '/h/p' })
  })
  test('strips matching quotes', () => {
    expect(parseCdArgs('"/a b"', '/w', '/h')).toEqual({ ok: true, path: '/a b' })
    expect(parseCdArgs("'rel dir'", '/w', '/h')).toEqual({ ok: true, path: '/w/rel dir' })
  })
})
