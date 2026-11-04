import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cancelIdleMemoryRelease,
  clearPerformanceMeasures,
  releaseMemoryNow,
  scheduleIdleMemoryRelease,
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

  test('releaseMemoryNow runs a full GC and reports RSS before and after', () => {
    const r = releaseMemoryNow()
    expect(r.rssBefore).toBeGreaterThan(0)
    expect(r.rssAfter).toBeGreaterThan(0)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
    const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
    Object.assign(process.env, vars)
    try {
      await fn()
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      cancelIdleMemoryRelease()
    }
  }

  test('scheduleIdleMemoryRelease fires once after the idle delay', () =>
    withEnv({ FNHARNESS_IDLE_RELEASE_MS: '20', FNHARNESS_IDLE_RELEASE_MIN_INTERVAL_MS: '0' }, async () => {
      let calls = 0
      scheduleIdleMemoryRelease(() => calls++)
      // Rescheduling restarts the countdown instead of stacking timers.
      scheduleIdleMemoryRelease(() => calls++)
      await Bun.sleep(100)
      expect(calls).toBe(1)
      // Cancelled before the delay: never fires.
      scheduleIdleMemoryRelease(() => calls++)
      cancelIdleMemoryRelease()
      await Bun.sleep(100)
      expect(calls).toBe(1)
      // Disabled with 0.
      process.env.FNHARNESS_IDLE_RELEASE_MS = '0'
      scheduleIdleMemoryRelease(() => calls++)
      await Bun.sleep(100)
      expect(calls).toBe(1)
    }))

  test('scheduleIdleMemoryRelease waits for the minimum interval', () =>
    withEnv({ FNHARNESS_IDLE_RELEASE_MS: '10', FNHARNESS_IDLE_RELEASE_MIN_INTERVAL_MS: '60000' }, async () => {
      releaseMemoryNow() // a release "just now"
      let calls = 0
      scheduleIdleMemoryRelease(() => calls++)
      await Bun.sleep(80)
      expect(calls).toBe(0)
    }))

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
