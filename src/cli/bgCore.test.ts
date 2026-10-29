import { describe, expect, test } from 'bun:test'
import {
  type BgMeta,
  backgroundPassthrough,
  deriveStatus,
  formatEventLine,
  formatPsTable,
  parseBgArgs,
  resolveId,
  shortId,
  shortPrompt,
  splitLines,
  tailFormatted,
} from './bgCore.js'

const meta = (id: string, over: Partial<BgMeta> = {}): BgMeta => ({
  id,
  sessionId: `${id}-0000-4000-8000-000000000000`,
  pid: 1234,
  cwd: '/tmp',
  prompt: 'haz algo',
  account: 'ollama',
  startedAt: new Date(2026, 9, 25, 9, 5).getTime(),
  passthrough: [],
  ...over,
})

describe('parseBgArgs', () => {
  test('value after --bg is the prompt, the rest is kept in order', () => {
    expect(parseBgArgs(['--permission-mode', 'plan', '--bg', 'haz X', '--model', 'm'])).toEqual({
      prompt: 'haz X',
      rest: ['--permission-mode', 'plan', '--model', 'm'],
    })
  })
  test('--background=prompt form', () => {
    expect(parseBgArgs(['--background=hola mundo'])).toEqual({ prompt: 'hola mundo', rest: [] })
  })
  test('--bg followed by a flag takes the trailing positional', () => {
    expect(parseBgArgs(['--bg', '--model', 'm', 'tarea'])).toEqual({ prompt: 'tarea', rest: ['--model', 'm'] })
  })
  test('no prompt at all', () => {
    expect(parseBgArgs(['--bg']).prompt).toBeNull()
  })
})

describe('resolveId', () => {
  const all = [meta('aaaa1111'), meta('aaaa2222'), meta('bbbb3333')]
  test('exact, unique prefix, ambiguous and missing', () => {
    expect(resolveId(all, 'bbbb3333')).toMatchObject({ kind: 'found' })
    expect(resolveId(all, 'bb')).toMatchObject({ kind: 'found' })
    expect(resolveId(all, 'aaaa')).toEqual({ kind: 'ambiguous', ids: ['aaaa1111', 'aaaa2222'] })
    expect(resolveId(all, 'zz')).toEqual({ kind: 'none' })
    expect(resolveId(all, undefined)).toEqual({ kind: 'none' })
  })
})

describe('deriveStatus', () => {
  test('alive wins, then stop mark, then exit code', () => {
    expect(deriveStatus({}, true, null)).toBe('running')
    expect(deriveStatus({ stoppedAt: 1 }, false, 143)).toBe('stopped')
    expect(deriveStatus({}, false, 0)).toBe('done')
    expect(deriveStatus({}, false, 2)).toBe('failed')
    expect(deriveStatus({}, false, null)).toBe('lost')
  })
})

describe('formatting', () => {
  test('shortId takes 8 hex chars', () => {
    expect(shortId('30faeddf-d563-4c0c-a0c6-950cf7911790')).toBe('30faeddf')
  })
  test('shortPrompt collapses whitespace and truncates', () => {
    expect(shortPrompt('a\n  b')).toBe('a b')
    expect(shortPrompt('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  })
  test('ps table has header, European date and aligned columns', () => {
    const t = formatPsTable([{ meta: meta('aaaa1111'), status: 'running' }])
    const [h, row] = t.split('\n')
    expect(h).toContain('ESTADO')
    expect(row).toContain('25/10 09:05')
    expect(row).toContain('running')
    expect(row!.indexOf('ollama')).toBe(h!.indexOf('CUENTA'))
  })
  test('empty ps', () => {
    expect(formatPsTable([])).toContain('No hay sesiones')
  })
})

describe('formatEventLine', () => {
  test('assistant text and tool_use', () => {
    const ev = { type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } }
    expect(formatEventLine(JSON.stringify(ev))).toBe('hola\n[tool] Bash ls -la')
  })
  test('result ok / error and init', () => {
    expect(formatEventLine(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1500 }))).toBe('[fin: ok en 1.5s]')
    expect(formatEventLine(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }))).toBe('[fin: error] boom')
    expect(formatEventLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'm', session_id: 's' }))).toContain('modelo m')
  })
  test('noise is dropped and non-JSON passes through', () => {
    expect(formatEventLine('')).toBeNull()
    expect(formatEventLine(JSON.stringify({ type: 'system', subtype: 'hook' }))).toBeNull()
    expect(formatEventLine('plain text')).toBe('plain text')
  })
})

test('splitLines keeps the unterminated tail', () => {
  const a = splitLines('', 'uno\ndos\ntr')
  expect(a).toEqual({ lines: ['uno', 'dos'], rest: 'tr' })
  expect(splitLines(a.rest, 'es\n')).toEqual({ lines: ['tres'], rest: '' })
})

test('backgroundPassthrough mirrors the permission mode', () => {
  expect(backgroundPassthrough('bypassPermissions')).toContain('bypassPermissions')
  expect(backgroundPassthrough('plan')).toEqual(['--permission-mode', 'plan'])
  expect(backgroundPassthrough('default')).toEqual([])
})

describe('tailFormatted', () => {
  const assistant = (text: string) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

  test('keeps only the last lines, skipping noise', () => {
    const text = [assistant('uno'), '{"type":"system","subtype":"hook"}', assistant('dos'), assistant('tres')].join('\n')
    expect(tailFormatted(text, 2)).toEqual(['dos', 'tres'])
  })

  test('drops the first line when the read started mid-line', () => {
    const text = ['cut-off garbage', assistant('entera')].join('\n')
    expect(tailFormatted(text, 5, true)).toEqual(['entera'])
    expect(tailFormatted(text, 5, false)).toEqual(['cut-off garbage', 'entera'])
  })
})
