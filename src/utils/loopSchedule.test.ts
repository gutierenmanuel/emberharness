import { describe, expect, test } from 'bun:test'
import {
  LOOP_SENTINEL,
  buildWakeupFirePrompt,
  clampWakeupDelay,
  cronForInstant,
  INITIAL_LOOP_STATE,
  intervalToCron,
  onLoopStopped,
  onTurnEnd,
  onWakeupFired,
  onWakeupScheduled,
  parseLoopArgs,
  validateWakeupInput,
} from './loopSchedule.js'

describe('parseLoopArgs', () => {
  test('leading interval', () => {
    expect(parseLoopArgs('5m /babysit-prs')).toEqual({
      mode: 'fixed',
      interval: { n: 5, unit: 'm' },
      prompt: '/babysit-prs',
    })
  })
  test('trailing every clause', () => {
    expect(parseLoopArgs('check the deploy every 20m')).toEqual({
      mode: 'fixed',
      interval: { n: 20, unit: 'm' },
      prompt: 'check the deploy',
    })
    expect(parseLoopArgs('run tests every 5 minutes')).toEqual({
      mode: 'fixed',
      interval: { n: 5, unit: 'm' },
      prompt: 'run tests',
    })
    expect(parseLoopArgs('ping every 2 hours')).toMatchObject({
      interval: { n: 2, unit: 'h' },
    })
  })
  test('every without a time expression is a dynamic prompt', () => {
    expect(parseLoopArgs('check every PR')).toEqual({
      mode: 'dynamic',
      prompt: 'check every PR',
    })
  })
  test('prompt only is dynamic', () => {
    expect(parseLoopArgs('check the deploy')).toEqual({
      mode: 'dynamic',
      prompt: 'check the deploy',
    })
  })
  test('interval only is fixed maintenance', () => {
    expect(parseLoopArgs('15m')).toEqual({
      mode: 'fixed',
      interval: { n: 15, unit: 'm' },
      prompt: null,
    })
  })
  test('empty and sentinel are dynamic maintenance', () => {
    expect(parseLoopArgs('  ')).toEqual({ mode: 'dynamic', prompt: null })
    expect(parseLoopArgs(LOOP_SENTINEL)).toEqual({ mode: 'dynamic', prompt: null })
  })
})

describe('intervalToCron', () => {
  test('clean minute steps', () => {
    expect(intervalToCron({ n: 5, unit: 'm' })).toMatchObject({ cron: '*/5 * * * *' })
    expect(intervalToCron({ n: 5, unit: 'm' }).roundedNote).toBeUndefined()
  })
  test('seconds round up to a minute', () => {
    expect(intervalToCron({ n: 30, unit: 's' }).cron).toBe('*/1 * * * *')
    expect(intervalToCron({ n: 90, unit: 's' }).cron).toBe('*/2 * * * *')
  })
  test('uneven minutes round to the nearest clean step', () => {
    const r = intervalToCron({ n: 7, unit: 'm' })
    expect(r.cron).toBe('*/6 * * * *')
    expect(r.roundedNote).toBeDefined()
  })
  test('minutes at or over 60 become hours', () => {
    expect(intervalToCron({ n: 120, unit: 'm' }).cron).toBe('0 */2 * * *')
    expect(intervalToCron({ n: 90, unit: 'm' }).roundedNote).toBeDefined()
  })
  test('hours and days', () => {
    expect(intervalToCron({ n: 2, unit: 'h' }).cron).toBe('0 */2 * * *')
    expect(intervalToCron({ n: 5, unit: 'h' }).cron).toBe('0 */4 * * *')
    expect(intervalToCron({ n: 1, unit: 'd' }).cron).toBe('0 0 */1 * *')
    expect(intervalToCron({ n: 24, unit: 'h' }).cron).toBe('0 0 */1 * *')
  })
})

describe('ScheduleWakeup validation', () => {
  test('clamps to 60..3600', () => {
    expect(clampWakeupDelay(5)).toEqual({ seconds: 60, clamped: true })
    expect(clampWakeupDelay(90)).toEqual({ seconds: 90, clamped: false })
    expect(clampWakeupDelay(99999)).toEqual({ seconds: 3600, clamped: true })
    expect(clampWakeupDelay(61.4).seconds).toBe(61)
  })
  test('stop needs nothing else', () => {
    expect(validateWakeupInput({ stop: true })).toEqual({ ok: true, stop: true })
  })
  test('requires delay and prompt otherwise', () => {
    expect(validateWakeupInput({ prompt: 'x' }).ok).toBe(false)
    expect(validateWakeupInput({ delaySeconds: 120 }).ok).toBe(false)
    expect(validateWakeupInput({ delaySeconds: 'abc', prompt: 'x' }).ok).toBe(false)
  })
  test('valid call is clamped', () => {
    expect(
      validateWakeupInput({ delaySeconds: 10, prompt: ' check ', reason: 'ci' }),
    ).toEqual({
      ok: true,
      stop: false,
      delaySeconds: 60,
      clamped: true,
      prompt: 'check',
      reason: 'ci',
    })
  })
})

describe('buildWakeupFirePrompt', () => {
  test('sentinel re-enters bare /loop', () => {
    expect(buildWakeupFirePrompt(LOOP_SENTINEL)).toBe('/loop')
  })
  test('slash prompts pass through', () => {
    expect(buildWakeupFirePrompt('/loop check ci')).toBe('/loop check ci')
  })
  test('plain prompts get a keep-going reminder', () => {
    const t = buildWakeupFirePrompt('check ci')
    expect(t.startsWith('check ci')).toBe(true)
    expect(t).toContain('ScheduleWakeup')
  })
})

test('cronForInstant pins minute hour dom month', () => {
  const d = new Date(2026, 9, 24, 14, 5, 30)
  expect(cronForInstant(d.getTime())).toBe('5 14 24 10 *')
})

describe('loop state machine', () => {
  test('idle loop does nothing', () => {
    expect(onTurnEnd(INITIAL_LOOP_STATE).action).toBe('none')
  })
  test('rescheduling each iteration keeps the loop alive', () => {
    let s = onWakeupScheduled('p')
    expect(onTurnEnd(s).action).toBe('none')
    s = onWakeupFired(s, false)
    s = onWakeupScheduled('p')
    expect(onTurnEnd(s).action).toBe('none')
  })
  test('missing reschedule grants one fallback then ends', () => {
    let s = onWakeupFired(onWakeupScheduled('p'), false)
    const r1 = onTurnEnd(s)
    expect(r1.action).toBe('fallback')
    s = onWakeupFired(r1.state, true)
    expect(onTurnEnd(s).action).toBe('end')
  })
  test('rescheduling during the fallback iteration resets it', () => {
    let s = onWakeupFired(onWakeupScheduled('p'), false)
    s = onWakeupFired(onTurnEnd(s).state, true)
    s = onWakeupScheduled('p')
    expect(onTurnEnd(s).action).toBe('none')
    s = onWakeupFired(s, false)
    expect(onTurnEnd(s).action).toBe('fallback')
  })
  test('stop deactivates', () => {
    expect(onTurnEnd(onLoopStopped()).action).toBe('none')
  })
})
