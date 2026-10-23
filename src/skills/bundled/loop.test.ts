import { describe, expect, test } from 'bun:test'
import { BUILT_IN_MAINTENANCE_PROMPT, buildLoopPrompt } from './loop.js'

describe('buildLoopPrompt', () => {
  test('fixed interval carries the computed cron and the prompt', () => {
    const t = buildLoopPrompt('5m check the deploy', null)
    expect(t).toContain('`*/5 * * * *`')
    expect(t).toContain('check the deploy')
    expect(t).toContain('CronCreate')
  })
  test('rounded intervals mention the rounding', () => {
    expect(buildLoopPrompt('7m x', null)).toContain('rounded')
  })
  test('no interval is self-paced and re-enters with /loop <args>', () => {
    const t = buildLoopPrompt('check CI', null)
    expect(t).toContain('ScheduleWakeup')
    expect(t).toContain('`/loop check CI`')
    expect(t).not.toContain('CronCreate')
  })
  test('bare /loop uses the sentinel and the maintenance prompt', () => {
    const t = buildLoopPrompt('', null)
    expect(t).toContain('<<autonomous-loop>>')
    expect(t).toContain(BUILT_IN_MAINTENANCE_PROMPT)
  })
  test('loop.md replaces the maintenance prompt', () => {
    expect(buildLoopPrompt('', 'custom body')).toContain('custom body')
  })
  test('interval only runs the maintenance prompt on a fixed schedule', () => {
    const t = buildLoopPrompt('15m', null)
    expect(t).toContain('`*/15 * * * *`')
    expect(t).toContain(BUILT_IN_MAINTENANCE_PROMPT)
  })
})
