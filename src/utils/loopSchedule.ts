// Pure logic behind `/loop` and `ScheduleWakeup`: argument parsing, interval to
// cron conversion, wake-up delay validation and the self-paced loop state
// machine. No I/O and no bootstrap state, so everything here is unit-testable.

/** Literal the model passes to ScheduleWakeup when the loop has no user prompt. */
export const LOOP_SENTINEL = '<<autonomous-loop>>'

export const WAKEUP_MIN_SECONDS = 60
export const WAKEUP_MAX_SECONDS = 3600
/** Delay of the one fallback wake-up scheduled when an iteration forgets to reschedule. */
export const WAKEUP_FALLBACK_SECONDS = 20 * 60

export type IntervalUnit = 's' | 'm' | 'h' | 'd'

export type LoopInterval = { n: number; unit: IntervalUnit }

export type LoopArgs =
  /** `/loop 5m <prompt>`, `/loop <prompt> every 5m`, or `/loop 5m` (prompt null = maintenance). */
  | { mode: 'fixed'; interval: LoopInterval; prompt: string | null }
  /** `/loop <prompt>` or bare `/loop`: the model picks the delay each iteration. */
  | { mode: 'dynamic'; prompt: string | null }

const LEADING_INTERVAL = /^(\d+)([smhd])$/i
const TRAILING_EVERY =
  /^(.*?)\s+every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i

function unitFromWord(word: string): IntervalUnit {
  const c = word.toLowerCase()[0]
  return (c === 's' || c === 'm' || c === 'h' || c === 'd' ? c : 'm') as IntervalUnit
}

/**
 * Parse the raw `/loop` arguments. Priority: leading interval token, then a
 * trailing `every <N><unit>` clause (only when what follows "every" is a time
 * expression, so `check every PR` has no interval), else dynamic mode.
 */
export function parseLoopArgs(raw: string): LoopArgs {
  const input = raw.trim()
  if (input === '' || input === LOOP_SENTINEL) {
    return { mode: 'dynamic', prompt: null }
  }
  const [first = '', ...rest] = input.split(/\s+/)
  const lead = LEADING_INTERVAL.exec(first)
  if (lead) {
    const prompt = rest.join(' ').trim()
    return {
      mode: 'fixed',
      interval: { n: Number(lead[1]), unit: lead[2]!.toLowerCase() as IntervalUnit },
      prompt: prompt === '' || prompt === LOOP_SENTINEL ? null : prompt,
    }
  }
  const trail = TRAILING_EVERY.exec(input)
  if (trail && trail[1]!.trim() !== '') {
    return {
      mode: 'fixed',
      interval: { n: Number(trail[2]), unit: unitFromWord(trail[3]!) },
      prompt: trail[1]!.trim(),
    }
  }
  return { mode: 'dynamic', prompt: input }
}

const MINUTE_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]
const HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12]

function nearest(candidates: number[], n: number): number {
  let best = candidates[0]!
  for (const c of candidates) {
    if (Math.abs(c - n) < Math.abs(best - n)) best = c
  }
  return best
}

export type IntervalCron = {
  cron: string
  /** Cadence in plain words, e.g. "every 5 minutes". */
  human: string
  /** Set when the requested interval did not map to a clean cron step. */
  roundedNote?: string
}

/**
 * Convert an interval into a 5-field cron expression. Seconds round up to a
 * minute; intervals that do not divide their unit evenly (7m, 90m) snap to the
 * nearest clean step and say so in `roundedNote`.
 */
export function intervalToCron(interval: LoopInterval): IntervalCron {
  let { n, unit } = interval
  const requested = `${n}${unit}`
  if (n < 1) n = 1
  if (unit === 's') {
    n = Math.ceil(n / 60)
    unit = 'm'
  }
  if (unit === 'm' && n >= 60) {
    n = Math.max(1, Math.round(n / 60))
    unit = 'h'
  }
  if (unit === 'h' && n >= 24) {
    n = Math.max(1, Math.round(n / 24))
    unit = 'd'
  }
  let cron: string
  let human: string
  if (unit === 'm') {
    n = nearest(MINUTE_DIVISORS, n)
    cron = `*/${n} * * * *`
    human = n === 1 ? 'every minute' : `every ${n} minutes`
  } else if (unit === 'h') {
    n = nearest(HOUR_DIVISORS, n)
    cron = `0 */${n} * * *`
    human = n === 1 ? 'every hour' : `every ${n} hours`
  } else {
    n = Math.min(Math.max(1, n), 30)
    cron = `0 0 */${n} * *`
    human = n === 1 ? 'every day at midnight' : `every ${n} days at midnight`
  }
  const effective = `${n}${unit}`
  // A request counts as rounded only when it changed unit-normalised value.
  const normalised = normalise(interval)
  const roundedNote =
    normalised === effective
      ? undefined
      : `${requested} is not a clean cron step, so it was rounded to ${human}`
  return { cron, human, ...(roundedNote ? { roundedNote } : {}) }
}

function normalise(i: LoopInterval): string {
  if (i.unit === 's') {
    const m = Math.max(1, Math.ceil(i.n / 60))
    return m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`
  }
  if (i.unit === 'm' && i.n >= 60 && i.n % 60 === 0) return `${i.n / 60}h`
  if (i.unit === 'h' && i.n >= 24 && i.n % 24 === 0) return `${i.n / 24}d`
  return `${i.n}${i.unit}`
}

// --- ScheduleWakeup -------------------------------------------------------

export type WakeupInput = {
  delaySeconds?: unknown
  prompt?: unknown
  reason?: unknown
  stop?: unknown
}

export type WakeupValidation =
  | { ok: true; stop: true }
  | {
      ok: true
      stop: false
      delaySeconds: number
      clamped: boolean
      prompt: string
      reason: string
    }
  | { ok: false; message: string }

/** Clamp a requested delay to [60, 3600] whole seconds. */
export function clampWakeupDelay(requested: number): {
  seconds: number
  clamped: boolean
} {
  const rounded = Math.round(requested)
  const seconds = Math.min(
    WAKEUP_MAX_SECONDS,
    Math.max(WAKEUP_MIN_SECONDS, rounded),
  )
  return { seconds, clamped: seconds !== requested }
}

/** Validate a ScheduleWakeup call. `stop: true` needs nothing else. */
export function validateWakeupInput(input: WakeupInput): WakeupValidation {
  if (input.stop === true) return { ok: true, stop: true }
  const d = input.delaySeconds
  if (typeof d !== 'number' || !Number.isFinite(d)) {
    return {
      ok: false,
      message: 'delaySeconds is required (a number of seconds, 60 to 3600) unless stop is true.',
    }
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    return {
      ok: false,
      message: 'prompt is required: pass the same /loop input again, or the sentinel ' + LOOP_SENTINEL + '.',
    }
  }
  const { seconds, clamped } = clampWakeupDelay(d)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  return {
    ok: true,
    stop: false,
    delaySeconds: seconds,
    clamped,
    prompt: input.prompt.trim(),
    reason,
  }
}

/**
 * Text enqueued when a wake-up fires. The sentinel re-enters the bare `/loop`
 * skill; a `/slash` prompt is passed through untouched; any other prompt gets a
 * reminder to keep the loop going, because it no longer carries the skill text.
 */
export function buildWakeupFirePrompt(prompt: string): string {
  const p = prompt.trim()
  if (p === LOOP_SENTINEL) return '/loop'
  if (p.startsWith('/')) return p
  return `${p}\n\n(This is an iteration of a self-paced loop. When you finish it, call ScheduleWakeup with the same prompt to schedule the next iteration, or with stop: true if the work is complete.)`
}

/** Cron string pinned to the minute of `atMs` (local time), for display and listing. */
export function cronForInstant(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

// --- Self-paced loop state machine ---------------------------------------

export type LoopState = {
  /** A self-paced loop exists (a wake-up was scheduled and not stopped). */
  active: boolean
  /** ScheduleWakeup was called since the last wake-up fired (or since the loop began). */
  rescheduled: boolean
  /** The single fallback wake-up has already been spent. */
  fallbackUsed: boolean
  /** Prompt of the last wake-up, reused by the fallback. */
  prompt: string | null
}

export const INITIAL_LOOP_STATE: LoopState = {
  active: false,
  rescheduled: false,
  fallbackUsed: false,
  prompt: null,
}

export function onWakeupScheduled(prompt: string): LoopState {
  return { active: true, rescheduled: true, fallbackUsed: false, prompt }
}

export function onWakeupFired(s: LoopState, isFallback: boolean): LoopState {
  if (!s.active) return s
  return { ...s, rescheduled: false, fallbackUsed: isFallback }
}

export function onLoopStopped(): LoopState {
  return INITIAL_LOOP_STATE
}

export type TurnEndAction =
  | { action: 'none'; state: LoopState }
  | { action: 'fallback'; state: LoopState; prompt: string }
  | { action: 'end'; state: LoopState }

/**
 * Called when a turn finishes. If the loop's iteration did not reschedule, one
 * fallback wake-up is granted; if the fallback iteration also fails to
 * reschedule, the loop ends.
 */
export function onTurnEnd(s: LoopState): TurnEndAction {
  if (!s.active || s.rescheduled || s.prompt === null) {
    return { action: 'none', state: s }
  }
  if (!s.fallbackUsed) {
    return {
      action: 'fallback',
      state: { ...s, rescheduled: true, fallbackUsed: true },
      prompt: s.prompt,
    }
  }
  return { action: 'end', state: INITIAL_LOOP_STATE }
}
