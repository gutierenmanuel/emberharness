import { describe, expect, test } from 'bun:test'
import { bundledRipgrepCandidates, findRealExecutable } from './ripgrep.js'

describe('findRealExecutable', () => {
  test('returns the first PATH entry that is an executable file', () => {
    const files = new Set(['/opt/bin/rg', '/usr/bin/rg'])
    expect(findRealExecutable('rg', '/nope:/opt/bin:/usr/bin', p => files.has(p))).toBe('/opt/bin/rg')
  })
  test('null when nothing real is on PATH (a shell function is not a file)', () => {
    expect(findRealExecutable('rg', '/usr/bin:/bin', () => false)).toBeNull()
    expect(findRealExecutable('rg', '', () => true)).toBeNull()
  })
  test('ignores relative PATH entries (no ./rg hijack)', () => {
    expect(findRealExecutable('rg', '.:bin:', () => true)).toBeNull()
  })
})

describe('bundledRipgrepCandidates', () => {
  const base = { env: {}, execDir: '/app', moduleDir: '/$bunfs/root', platform: 'linux', arch: 'x64' }
  test('looks next to the binary before the (virtual) bundle path', () => {
    expect(bundledRipgrepCandidates(base)).toEqual([
      '/app/vendor/ripgrep/x64-linux/rg',
      '/$bunfs/root/vendor/ripgrep/x64-linux/rg',
    ])
  })
  test('FNHARNESS_RG override goes first', () => {
    expect(bundledRipgrepCandidates({ ...base, env: { FNHARNESS_RG: '/x/rg' } })[0]).toBe('/x/rg')
  })
  test('windows uses rg.exe', () => {
    expect(bundledRipgrepCandidates({ ...base, platform: 'win32' })[0]).toBe('/app/vendor/ripgrep/x64-win32/rg.exe')
  })
})
