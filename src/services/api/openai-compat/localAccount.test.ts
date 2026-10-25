import { afterEach, describe, expect, test } from 'bun:test'
import { isLocalAccountActive, resetActiveProfileForTesting, setActiveProfile, type MultimodelProfile } from './profiles.js'

const profile = (baseUrl: string): MultimodelProfile => ({
  provider: 'custom', label: 'x', baseUrl, apiKey: undefined, model: 'm', smallModel: 'm', maxTokensParam: 'max_tokens',
})

afterEach(() => resetActiveProfileForTesting())

describe('isLocalAccountActive', () => {
  test('localhost, 127.0.0.1 and [::1] are local', () => {
    for (const u of ['http://localhost:8082/v1', 'http://127.0.0.1:8090/v1', 'http://[::1]:8082/v1']) {
      setActiveProfile(profile(u), 'a', {})
      expect(isLocalAccountActive()).toBe(true)
    }
  })
  test('remote accounts and claude (no profile) are not local', () => {
    setActiveProfile(profile('https://api.openai.com/v1'), 'a', {})
    expect(isLocalAccountActive()).toBe(false)
    setActiveProfile(profile('http://127.0.0.2:8000/v1'), 'a', {})
    expect(isLocalAccountActive()).toBe(false)
    setActiveProfile(null, 'claude', {})
    expect(isLocalAccountActive()).toBe(false)
  })
})
