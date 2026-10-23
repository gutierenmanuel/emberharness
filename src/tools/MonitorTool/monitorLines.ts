// Pure line pipeline for the Monitor tool: stdout chunks in, batched event
// text out. Splits lines, strips ANSI, applies include/exclude filters, caps
// line length, and rate-limits floods. The caller owns timers and I/O.

export const MONITOR_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const MONITOR_MAX_TIMEOUT_MS = 30 * 60 * 1000
export const MONITOR_MAX_LINE_CHARS = 2000
/** Lines delivered per rate window; the rest are counted as dropped. */
export const MONITOR_MAX_LINES_PER_WINDOW = 100
export const MONITOR_RATE_WINDOW_MS = 10_000
/** Total dropped lines after which the watch is stopped as too noisy. */
export const MONITOR_MAX_DROPPED = 5000
/** Lines per notification; larger bursts are split over several. */
export const MONITOR_MAX_LINES_PER_EVENT = 40

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/** Clamp a requested deadline to (0, 30 min]; default 5 min. */
export function clampMonitorTimeout(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return MONITOR_DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.round(requested), MONITOR_MAX_TIMEOUT_MS)
}

export type LineFilter = { include?: RegExp; exclude?: RegExp }

/** Compile optional regex strings; returns an error message when one is invalid. */
export function compileLineFilter(
  include?: string,
  exclude?: string,
): { ok: true; filter: LineFilter } | { ok: false; message: string } {
  const filter: LineFilter = {}
  try {
    if (include) filter.include = new RegExp(include)
    if (exclude) filter.exclude = new RegExp(exclude)
  } catch (e) {
    return { ok: false, message: `Invalid regular expression: ${(e as Error).message}` }
  }
  return { ok: true, filter }
}

export function passesFilter(line: string, f: LineFilter): boolean {
  if (f.include && !f.include.test(line)) return false
  if (f.exclude && f.exclude.test(line)) return false
  return true
}

export function truncateLine(line: string): string {
  return line.length > MONITOR_MAX_LINE_CHARS
    ? `${line.slice(0, MONITOR_MAX_LINE_CHARS)}... [truncated ${line.length - MONITOR_MAX_LINE_CHARS} chars]`
    : line
}

export type MonitorBatch = {
  lines: string[]
  /** Lines discarded by the rate limiter since the previous batch. */
  dropped: number
}

export type MonitorLineProcessor = {
  /** Feed a raw stdout chunk. */
  push(chunk: string, now: number): void
  /** Take the next batch of pending lines (null when nothing is pending). */
  take(now: number): MonitorBatch | null
  /** Flush a trailing partial line at end of stream. */
  end(now: number): void
  /** True once the watch dropped more than MONITOR_MAX_DROPPED lines. */
  readonly tooNoisy: boolean
  readonly pending: number
}

export function createMonitorLineProcessor(filter: LineFilter = {}): MonitorLineProcessor {
  let partial = ''
  const queue: string[] = []
  let dropped = 0
  let totalDropped = 0
  let windowStart = 0
  let inWindow = 0

  function accept(raw: string, now: number): void {
    const line = stripAnsi(raw).replace(/\r$/, '')
    if (line.trim() === '') return
    if (!passesFilter(line, filter)) return
    if (now - windowStart >= MONITOR_RATE_WINDOW_MS) {
      windowStart = now
      inWindow = 0
    }
    if (inWindow >= MONITOR_MAX_LINES_PER_WINDOW) {
      dropped += 1
      totalDropped += 1
      return
    }
    inWindow += 1
    queue.push(truncateLine(line))
  }

  return {
    push(chunk, now) {
      const parts = (partial + chunk).split('\n')
      partial = parts.pop() ?? ''
      for (const p of parts) accept(p, now)
    },
    take() {
      if (queue.length === 0 && dropped === 0) return null
      const lines = queue.splice(0, MONITOR_MAX_LINES_PER_EVENT)
      const d = dropped
      dropped = 0
      return { lines, dropped: d }
    },
    end(now) {
      if (partial !== '') accept(partial, now)
      partial = ''
    },
    get tooNoisy() {
      return totalDropped > MONITOR_MAX_DROPPED
    },
    get pending() {
      return queue.length
    },
  }
}

/** Notification body for one batch (one line per event, plus a drop notice). */
export function formatMonitorBatch(b: MonitorBatch): string {
  const body = b.lines.join('\n')
  if (b.dropped === 0) return body
  const note = `[${b.dropped} line${b.dropped === 1 ? '' : 's'} dropped: output too fast. Filter the command output (e.g. grep --line-buffered) to receive fewer events.]`
  return body === '' ? note : `${body}\n${note}`
}
