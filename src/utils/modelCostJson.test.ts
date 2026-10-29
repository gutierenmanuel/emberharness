import { describe, expect, test } from 'bun:test'
import { getModelCosts } from './modelCost.js'
import { firstPartyNameToCanonical } from './model/model.js'

const usage = { input_tokens: 0, output_tokens: 0 } as never

describe('tarifas desde claude-models.json', () => {
  test('modelos 5.5 y 4.x se tarifan por su entrada', () => {
    expect(getModelCosts('claude-sonnet-5-5', usage)).toMatchObject({
      inputTokens: 2, outputTokens: 10, promptCacheWriteTokens: 2.5, promptCacheReadTokens: 0.1,
    })
    expect(getModelCosts('claude-opus-5-5', usage)).toMatchObject({
      inputTokens: 4, outputTokens: 20, promptCacheWriteTokens: 5, promptCacheReadTokens: 0.2,
    })
    expect(getModelCosts('claude-haiku-4-5-20251001', usage).inputTokens).toBe(1)
    expect(getModelCosts('claude-3-5-haiku-20241022', usage).inputTokens).toBe(0.8)
  })

  test('Fable 5.1 se reconoce y se tarifa (la caché cuesta 0.025x)', () => {
    expect(firstPartyNameToCanonical('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(getModelCosts('claude-fable-5-1', usage)).toMatchObject({
      inputTokens: 10, outputTokens: 50, promptCacheWriteTokens: 12.5, promptCacheReadTokens: 0.25,
    })
  })

  test('Haiku 5.5 cobra más cuando el prompt supera 100k tokens (caché incluida)', () => {
    const short = { input_tokens: 100_000, output_tokens: 0 } as never
    const long = { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 0 } as never
    expect(getModelCosts('claude-haiku-5-5', short)).toMatchObject({ inputTokens: 0.1, outputTokens: 0.5 })
    expect(getModelCosts('claude-haiku-5-5', long)).toMatchObject({
      inputTokens: 0.5, outputTokens: 2.5, promptCacheWriteTokens: 0.625, promptCacheReadTokens: 0.05,
    })
  })

  test('un modelo futuro se reconoce como canónico sin tocar código', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-6-0')).toBe('claude-sonnet-6-0')
    expect(firstPartyNameToCanonical('claude-opus-5-5-20271001')).toBe('claude-opus-5-5')
  })
})
