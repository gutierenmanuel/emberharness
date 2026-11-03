/**
 * Memory debugging hook for long-lived sessions (fnharness).
 *
 * `kill -USR2 <pid>` writes a JSON with process.memoryUsage(), the Bun/JSC
 * heap statistics (object counts per type) and /proc/self/smaps_rollup to
 * `$FNHARNESS_MEMDUMP_DIR` (default `<config dir>/memdumps/`). With
 * `FNHARNESS_MEMDUMP_SNAPSHOT=1` it also writes a V8-format heap snapshot
 * next to it (slow and large: only for debugging).
 *
 * The handler only reads and writes files: it never touches the session, so
 * signalling a running session is safe. Without this handler SIGUSR2 would
 * kill the process (default action), which is worse than any side effect.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'

let installed = false

export function memDumpDir(): string {
  return (
    process.env.FNHARNESS_MEMDUMP_DIR ||
    join(getClaudeConfigHomeDir(), 'memdumps')
  )
}

/** Collects heap statistics; never throws. */
export function collectMemoryStats(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    memoryUsage: process.memoryUsage(),
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsc = require('bun:jsc') as {
      heapStats: () => {
        heapSize: number
        heapCapacity: number
        extraMemorySize: number
        objectCount: number
        protectedObjectCount: number
        objectTypeCounts: Record<string, number>
        protectedObjectTypeCounts: Record<string, number>
      }
      memoryUsage?: () => unknown
    }
    const s = jsc.heapStats()
    const top = Object.entries(s.objectTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
    out.jsc = {
      heapSize: s.heapSize,
      heapCapacity: s.heapCapacity,
      extraMemorySize: s.extraMemorySize,
      objectCount: s.objectCount,
      protectedObjectCount: s.protectedObjectCount,
      topObjectTypeCounts: Object.fromEntries(top),
      memoryUsage: jsc.memoryUsage?.(),
    }
  } catch (e) {
    out.jscError = String(e)
  }
  try {
    out.smapsRollup = readFileSync('/proc/self/smaps_rollup', 'utf8')
  } catch {
    // not Linux
  }
  return out
}

/** Writes stats (and optionally a heap snapshot); returns the paths written. */
export function writeMemoryDump(snapshot: boolean): string[] {
  const dir = memDumpDir()
  mkdirSync(dir, { recursive: true })
  const base = join(dir, `${process.pid}-${Date.now()}`)
  const written: string[] = []
  const stats = collectMemoryStats()
  if (typeof Bun !== 'undefined') {
    // RSS after a full synchronous GC tells apart live JS data (stays) from
    // garbage or allocator pages not yet returned to the OS (goes away).
    Bun.gc(true)
    stats.rssAfterFullGC = process.memoryUsage().rss
  }
  writeFileSync(`${base}.json`, JSON.stringify(stats, null, 2), {
    mode: 0o600,
  })
  written.push(`${base}.json`)
  if (snapshot && typeof Bun !== 'undefined') {
    // @ts-expect-error 2nd argument exists in current Bun
    const snap = Bun.generateHeapSnapshot('v8', 'arraybuffer')
    writeFileSync(`${base}.heapsnapshot`, new Uint8Array(snap as ArrayBuffer), {
      mode: 0o600,
    })
    written.push(`${base}.heapsnapshot`)
    Bun.gc(true)
  }
  return written
}

/**
 * Drops buffered performance.measure() entries. Nothing in this codebase reads
 * measures back, but React's development build (cli-dev, or any build where
 * NODE_ENV is not 'production') records one per component render, and the
 * runtime buffers them without limit. Marks are left alone: the startup and
 * query profilers read and clear their own marks.
 */
export function clearPerformanceMeasures(): void {
  try {
    performance.clearMeasures()
  } catch {
    // runtime without the User Timing API
  }
}

const MEASURE_SWEEP_MS = 10_000

/** Installs the SIGUSR2 handler and the measure sweeper once. */
export function installMemoryDebugSignal(): void {
  if (installed) return
  installed = true
  setInterval(clearPerformanceMeasures, MEASURE_SWEEP_MS).unref()
  if (process.platform === 'win32') return
  process.on('SIGUSR2', () => {
    try {
      writeMemoryDump(process.env.FNHARNESS_MEMDUMP_SNAPSHOT === '1')
    } catch {
      // debugging aid: never break the session
    }
  })
}
