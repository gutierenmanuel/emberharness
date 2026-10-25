import { describe, expect, test } from 'bun:test'
import { defaultLocalSettingSources, localLeanEnabled } from './leanLocal.js'

const LOCAL = 'http://127.0.0.1:8090/v1'

describe('defaultLocalSettingSources', () => {
  test('local accounts get user-only sources by default', () => {
    for (const url of [LOCAL, 'http://localhost:11434/v1', 'http://[::1]:8082/v1']) {
      expect(defaultLocalSettingSources({ baseUrl: url, explicitFlag: undefined, env: {} })).toBe('user')
    }
  })
  test('remote accounts and claude are untouched', () => {
    expect(defaultLocalSettingSources({ baseUrl: 'https://api.openai.com/v1', explicitFlag: undefined, env: {} })).toBeUndefined()
    expect(defaultLocalSettingSources({ baseUrl: undefined, explicitFlag: undefined, env: {} })).toBeUndefined()
  })
  test('an explicit --setting-sources always wins, even an empty one', () => {
    expect(defaultLocalSettingSources({ baseUrl: LOCAL, explicitFlag: 'user,project', env: {} })).toBeUndefined()
    expect(defaultLocalSettingSources({ baseUrl: LOCAL, explicitFlag: '', env: {} })).toBeUndefined()
  })
  test('FNHARNESS_LOCAL_LEAN=0 turns it off', () => {
    for (const v of ['0', 'false', 'off', 'OFF']) {
      expect(localLeanEnabled({ FNHARNESS_LOCAL_LEAN: v })).toBe(false)
      expect(defaultLocalSettingSources({ baseUrl: LOCAL, explicitFlag: undefined, env: { FNHARNESS_LOCAL_LEAN: v } })).toBeUndefined()
    }
    expect(localLeanEnabled({ FNHARNESS_LOCAL_LEAN: '1' })).toBe(true)
  })
})
