import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearPerformanceMeasures,
  collectMemoryStats,
  writeMemoryDump,
} from './memoryDebug.js'

describe('memoryDebug', () => {
  test('collectMemoryStats reports RSS and JSC object counts', () => {
    const s = collectMemoryStats() as {
      memoryUsage: { rss: number }
      jsc?: { heapSize: number; topObjectTypeCounts: Record<string, number> }
    }
    expect(s.memoryUsage.rss).toBeGreaterThan(0)
    expect(s.jsc?.heapSize).toBeGreaterThan(0)
    expect(Object.keys(s.jsc?.topObjectTypeCounts ?? {}).length).toBeGreaterThan(0)
  })

  test('writeMemoryDump writes the stats JSON with RSS after a full GC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-memdump-'))
    const prev = process.env.FNHARNESS_MEMDUMP_DIR
    process.env.FNHARNESS_MEMDUMP_DIR = dir
    try {
      const [json] = writeMemoryDump(false)
      expect(json!.startsWith(dir)).toBe(true)
      expect(existsSync(json!)).toBe(true)
      const data = JSON.parse(readFileSync(json!, 'utf8'))
      expect(data.pid).toBe(process.pid)
      expect(data.rssAfterFullGC).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env.FNHARNESS_MEMDUMP_DIR
      else process.env.FNHARNESS_MEMDUMP_DIR = prev
    }
  })

  test('clearPerformanceMeasures drops buffered measures but keeps marks', () => {
    performance.mark('memdebug-keep')
    for (let i = 0; i < 50; i++) performance.measure(`memdebug-${i}`)
    expect(performance.getEntriesByType('measure').length).toBeGreaterThanOrEqual(50)
    clearPerformanceMeasures()
    expect(performance.getEntriesByType('measure').length).toBe(0)
    expect(performance.getEntriesByName('memdebug-keep').length).toBe(1)
    performance.clearMarks('memdebug-keep')
  })
})
