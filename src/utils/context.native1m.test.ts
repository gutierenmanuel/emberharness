import { afterEach, describe, expect, test } from 'bun:test'
import {
  getContextWindowForModel,
  hasNative1MContext,
  modelSupports1M,
} from './context.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
})

describe('1M nativo de Sonnet 5.5 y Opus 5.5', () => {
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    test(`${model}: 1M con y sin sufijo [1m], y modelSupports1M`, () => {
      expect(getContextWindowForModel(model)).toBe(1_000_000)
      expect(getContextWindowForModel(`${model}[1m]`)).toBe(1_000_000)
      expect(hasNative1MContext(model)).toBe(true)
      expect(modelSupports1M(model)).toBe(true)
    })

    test(`${model}: CLAUDE_CODE_DISABLE_1M_CONTEXT lo devuelve a 200k`, () => {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
      expect(getContextWindowForModel(model)).toBe(200_000)
      expect(hasNative1MContext(model)).toBe(false)
    })
  }

  test('otros modelos no cambian: 200k por defecto', () => {
    expect(getContextWindowForModel('claude-opus-4-6')).toBe(200_000)
    expect(getContextWindowForModel('claude-sonnet-4-6')).toBe(200_000)
    expect(getContextWindowForModel('claude-haiku-4-5')).toBe(200_000)
    expect(hasNative1MContext('claude-opus-4-6')).toBe(false)
  })
})
