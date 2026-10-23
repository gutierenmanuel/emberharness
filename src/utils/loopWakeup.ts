// Session state for self-paced `/loop`: creates and cancels ScheduleWakeup
// wake-ups (one-shot session cron tasks pinned to an exact instant) and tracks
// the loop state machine from loopSchedule.ts.

import { randomUUID } from 'crypto'
import {
  addSessionCronTask,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from '../bootstrap/state.js'
import {
  buildWakeupFirePrompt,
  cronForInstant,
  INITIAL_LOOP_STATE,
  type LoopState,
  onLoopStopped,
  onTurnEnd,
  onWakeupFired,
  onWakeupScheduled,
  WAKEUP_FALLBACK_SECONDS,
} from './loopSchedule.js'

let loopState: LoopState = INITIAL_LOOP_STATE

export function getLoopState(): LoopState {
  return loopState
}

export function resetLoopStateForTests(): void {
  loopState = INITIAL_LOOP_STATE
}

function pendingWakeupIds(): string[] {
  return getSessionCronTasks()
    .filter(t => t.wakeup)
    .map(t => t.id)
}

function addWakeup(
  delaySeconds: number,
  prompt: string,
  reason: string,
  fallback: boolean,
): { id: string; fireAt: number } {
  removeSessionCronTasks(pendingWakeupIds())
  const now = Date.now()
  const fireAt = now + delaySeconds * 1000
  const id = randomUUID().slice(0, 8)
  addSessionCronTask({
    id,
    cron: cronForInstant(fireAt),
    prompt: buildWakeupFirePrompt(prompt),
    createdAt: now,
    wakeup: true,
    fireAt,
    fallback,
    ...(reason ? { reason } : {}),
  })
  setScheduledTasksEnabled(true)
  return { id, fireAt }
}

/** ScheduleWakeup: replace any pending wake-up with one `delaySeconds` out. */
export function scheduleWakeup(
  delaySeconds: number,
  prompt: string,
  reason: string,
): { id: string; fireAt: number } {
  const r = addWakeup(delaySeconds, prompt, reason, false)
  loopState = onWakeupScheduled(prompt)
  return r
}

/** ScheduleWakeup with stop: true. Returns how many pending wake-ups were cancelled. */
export function stopWakeups(): number {
  const n = removeSessionCronTasks(pendingWakeupIds())
  loopState = onLoopStopped()
  return n
}

/** Scheduler callback when a wake-up fires. */
export function noteWakeupFired(fallback: boolean): void {
  loopState = onWakeupFired(loopState, fallback)
}

/** CronDelete of a wake-up: if none remain pending, the loop is over. */
export function noteCronDeleted(): void {
  if (loopState.active && pendingWakeupIds().length === 0) {
    loopState = onLoopStopped()
  }
}

/**
 * Called when a turn ends. Grants the one fallback wake-up to an iteration
 * that forgot to reschedule, and ends the loop when the fallback also did.
 * Returns what happened so the REPL can tell the user.
 */
export function handleLoopTurnEnd(): 'none' | 'fallback' | 'end' {
  const r = onTurnEnd(loopState)
  loopState = r.state
  if (r.action === 'fallback') {
    addWakeup(
      WAKEUP_FALLBACK_SECONDS,
      r.prompt,
      'fallback: the previous iteration did not reschedule',
      true,
    )
  }
  return r.action
}
