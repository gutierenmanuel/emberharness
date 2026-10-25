import { describe, expect, test } from 'bun:test'
import { displayAgentSummary, formatShortDuration } from './agentNotificationSummary.js'

describe('agent notification summary', () => {
  test('completed becomes finished with duration', () => {
    expect(displayAgentSummary('Agent "count src" completed', 11000)).toBe('Agent "count src" finished · 11s')
  })
  test('without duration only finished', () => {
    expect(displayAgentSummary('Agent "x" completed')).toBe('Agent "x" finished')
  })
  test('failed and stopped untouched', () => {
    expect(displayAgentSummary('Agent "x" failed: boom', 5000)).toBe('Agent "x" failed: boom')
    expect(displayAgentSummary('Agent "x" was stopped', 5000)).toBe('Agent "x" was stopped')
  })
  test('duration format', () => {
    expect(formatShortDuration(400)).toBe('0s')
    expect(formatShortDuration(65000)).toBe('1m 5s')
    expect(formatShortDuration(120000)).toBe('2m')
  })
})
