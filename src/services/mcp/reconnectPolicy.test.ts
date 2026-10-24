import { describe, expect, test } from 'bun:test'
import {
  decideStdioRestart,
  formatRestartNotice,
  INITIAL_RESTART_STATE,
  nextBackoffMs,
  STABLE_UPTIME_MS,
  STDIO_MAX_ATTEMPTS,
} from './reconnectPolicy.js'

describe('nextBackoffMs', () => {
  test('doubles from 1 s and caps at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(a => nextBackoffMs(a))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
  test('clamps nonsense attempts', () => {
    expect(nextBackoffMs(0)).toBe(1000)
    expect(nextBackoffMs(-3)).toBe(1000)
  })
})

describe('decideStdioRestart', () => {
  test('a crash loop gives up after the attempt budget', () => {
    let state = INITIAL_RESTART_STATE
    const delays: number[] = []
    let now = 1_000_000
    for (let i = 0; i < STDIO_MAX_ATTEMPTS; i++) {
      const d = decideStdioRestart(state, now)
      expect(d.action).toBe('retry')
      if (d.action === 'retry') delays.push(d.delayMs)
      state = { ...d.next, connectedAt: now + 500 } // reconnected, dies 0.5 s later
      now += 1000
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000])
    const last = decideStdioRestart(state, now)
    expect(last.action).toBe('give-up')
  })

  test('stable uptime resets the budget', () => {
    const state = { attempts: STDIO_MAX_ATTEMPTS, connectedAt: 0 }
    const d = decideStdioRestart(state, STABLE_UPTIME_MS + 1)
    expect(d).toMatchObject({ action: 'retry', attempt: 1, delayMs: 1000 })
  })

  test('just under the stable threshold does not reset', () => {
    const state = { attempts: STDIO_MAX_ATTEMPTS, connectedAt: 0 }
    expect(decideStdioRestart(state, STABLE_UPTIME_MS - 1).action).toBe('give-up')
  })

  test('first death of a fresh server retries once at 1 s', () => {
    expect(decideStdioRestart(INITIAL_RESTART_STATE, 5)).toMatchObject({ action: 'retry', attempt: 1, delayMs: 1000 })
  })
})

test('formatRestartNotice', () => {
  const retry = decideStdioRestart(INITIAL_RESTART_STATE, 0)
  expect(formatRestartNotice('foo', retry)).toBe('MCP: foo stopped, restarting (1/4)')
  const giveUp = decideStdioRestart({ attempts: 4, connectedAt: null }, 0)
  expect(formatRestartNotice('foo', giveUp)).toContain('gave up after 4 restarts')
})
