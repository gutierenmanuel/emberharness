import { beforeEach, describe, expect, test } from 'bun:test'
import { getSessionCronTasks, removeSessionCronTasks } from '../bootstrap/state.js'
import {
  cancelPendingWakeup,
  getLoopState,
  hasPendingWakeup,
  resetLoopStateForTests,
  scheduleWakeup,
  subscribePendingWakeup,
} from './loopWakeup.js'

beforeEach(() => {
  removeSessionCronTasks(getSessionCronTasks().map(t => t.id))
  resetLoopStateForTests()
})

describe('cancelPendingWakeup (Esc on an idle autopaced loop)', () => {
  test('returns false with nothing pending', () => {
    expect(hasPendingWakeup()).toBe(false)
    expect(cancelPendingWakeup()).toBe(false)
  })

  test('removes the wake-up and ends the loop', () => {
    scheduleWakeup(120, 'check deploy', 'waiting')
    expect(hasPendingWakeup()).toBe(true)
    expect(getLoopState().active).toBe(true)
    expect(cancelPendingWakeup()).toBe(true)
    expect(hasPendingWakeup()).toBe(false)
    expect(getLoopState().active).toBe(false)
  })

  test('notifies subscribers on add and cancel', () => {
    let calls = 0
    const off = subscribePendingWakeup(() => calls++)
    scheduleWakeup(60, 'x', 'r')
    cancelPendingWakeup()
    off()
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
