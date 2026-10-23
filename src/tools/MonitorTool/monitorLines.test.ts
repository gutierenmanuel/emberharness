import { describe, expect, test } from 'bun:test'
import {
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_LINES_PER_WINDOW,
  MONITOR_MAX_LINE_CHARS,
  MONITOR_MAX_TIMEOUT_MS,
  clampMonitorTimeout,
  compileLineFilter,
  createMonitorLineProcessor,
  formatMonitorBatch,
  stripAnsi,
} from './monitorLines.js'

describe('monitor lines', () => {
  test('splits chunks on newlines and keeps the partial tail', () => {
    const p = createMonitorLineProcessor()
    p.push('one\ntw', 0)
    expect(p.take(0)).toEqual({ lines: ['one'], dropped: 0 })
    p.push('o\nthree', 0)
    expect(p.take(0)?.lines).toEqual(['two'])
    p.end(0)
    expect(p.take(0)?.lines).toEqual(['three'])
  })
  test('drops blank lines and strips ANSI', () => {
    const p = createMonitorLineProcessor()
    p.push('\n  \n\x1b[31mred\x1b[0m\r\n', 0)
    expect(p.take(0)?.lines).toEqual(['red'])
    expect(stripAnsi('\x1b[1mx\x1b[0m')).toBe('x')
  })
  test('include and exclude filters', () => {
    const f = compileLineFilter('ERROR|WARN', 'ignore')
    if (!f.ok) throw new Error('bad')
    const p = createMonitorLineProcessor(f.filter)
    p.push('ok\nERROR a\nWARN ignore me\nWARN b\n', 0)
    expect(p.take(0)?.lines).toEqual(['ERROR a', 'WARN b'])
  })
  test('invalid regex reports an error', () => {
    expect(compileLineFilter('(').ok).toBe(false)
  })
  test('long lines are truncated', () => {
    const p = createMonitorLineProcessor()
    p.push('x'.repeat(MONITOR_MAX_LINE_CHARS + 50) + '\n', 0)
    const line = p.take(0)!.lines[0]!
    expect(line.length).toBeLessThan(MONITOR_MAX_LINE_CHARS + 60)
    expect(line).toContain('truncated 50 chars')
  })
  test('rate limit drops the flood and reports it', () => {
    const p = createMonitorLineProcessor()
    const n = MONITOR_MAX_LINES_PER_WINDOW + 25
    p.push(Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n', 0)
    let delivered = 0
    let dropped = 0
    for (let b = p.take(0); b; b = p.take(0)) {
      delivered += b.lines.length
      dropped += b.dropped
    }
    expect(delivered).toBe(MONITOR_MAX_LINES_PER_WINDOW)
    expect(dropped).toBe(25)
    expect(formatMonitorBatch({ lines: ['a'], dropped: 3 })).toContain('3 lines dropped')
  })
  test('window resets after the rate window passes', () => {
    const p = createMonitorLineProcessor()
    p.push(Array.from({ length: 150 }, (_, i) => `a${i}`).join('\n') + '\n', 0)
    while (p.take(0)) {}
    p.push('later\n', 20_000)
    expect(p.take(20_000)?.lines).toEqual(['later'])
  })
  test('timeout clamp', () => {
    expect(clampMonitorTimeout()).toBe(MONITOR_DEFAULT_TIMEOUT_MS)
    expect(clampMonitorTimeout(-5)).toBe(MONITOR_DEFAULT_TIMEOUT_MS)
    expect(clampMonitorTimeout(10_000)).toBe(10_000)
    expect(clampMonitorTimeout(99_999_999)).toBe(MONITOR_MAX_TIMEOUT_MS)
  })
})
