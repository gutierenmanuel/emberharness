import { describe, expect, test } from 'bun:test'
import { blockedSwitchMessage } from './switchGuard.js'

describe('blockedSwitchMessage', () => {
  test('deny and ask carry the hook reason', () => {
    expect(blockedSwitchMessage('deny', 'retired')).toBe('Model switch blocked by a PreModelSwitch hook: retired')
    expect(blockedSwitchMessage('deny', undefined)).toBe('Model switch blocked by a PreModelSwitch hook')
    expect(blockedSwitchMessage('ask', 'sure?')).toContain('needs confirmation')
  })
})
