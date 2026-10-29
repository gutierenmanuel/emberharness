import { afterEach, describe, expect, test } from 'bun:test'
import { getWireVersion, MIN_API_CLIENT_VERSION } from './wireVersion.js'

const original = process.env.FNHARNESS_API_VERSION

afterEach(() => {
  if (original === undefined) delete process.env.FNHARNESS_API_VERSION
  else process.env.FNHARNESS_API_VERSION = original
})

describe('getWireVersion', () => {
  test('never goes below the minimum accepted by the API', () => {
    delete process.env.FNHARNESS_API_VERSION
    const [maj, min, pat] = getWireVersion().split('.').map(n => Number.parseInt(n, 10))
    const [mmaj, mmin, mpat] = MIN_API_CLIENT_VERSION.split('.').map(n => Number.parseInt(n, 10))
    expect([maj!, min!, pat!] >= [mmaj!, mmin!, mpat!] || maj! > mmaj!).toBe(true)
    expect(getWireVersion()).not.toBe('2.1.87')
  })

  test('FNHARNESS_API_VERSION overrides it', () => {
    process.env.FNHARNESS_API_VERSION = '2.2.0'
    expect(getWireVersion()).toBe('2.2.0')
  })
})
