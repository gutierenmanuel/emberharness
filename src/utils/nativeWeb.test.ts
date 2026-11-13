import { afterEach, describe, expect, test } from 'bun:test'
import { getAllBaseTools } from '../tools.js'
import { isNativeWebEnabled } from './nativeWeb.js'

const original = process.env.FNHARNESS_NATIVE_WEB

afterEach(() => {
  if (original === undefined) delete process.env.FNHARNESS_NATIVE_WEB
  else process.env.FNHARNESS_NATIVE_WEB = original
})

const names = () => getAllBaseTools().map(t => t.name)

describe('herramientas web nativas', () => {
  test('por defecto WebSearch y WebFetch no están', () => {
    delete process.env.FNHARNESS_NATIVE_WEB
    expect(isNativeWebEnabled()).toBe(false)
    expect(names()).not.toContain('WebSearch')
    expect(names()).not.toContain('WebFetch')
  })

  test('FNHARNESS_NATIVE_WEB=1 las reactiva', () => {
    process.env.FNHARNESS_NATIVE_WEB = '1'
    expect(isNativeWebEnabled()).toBe(true)
    expect(names()).toContain('WebSearch')
    expect(names()).toContain('WebFetch')
  })
})
