import { describe, expect, test } from 'bun:test'
import { getModelCosts } from './modelCost.js'
import { firstPartyNameToCanonical } from './model/model.js'

const usage = { input_tokens: 0, output_tokens: 0 } as never

describe('tarifas desde claude-models.json', () => {
  test('modelos 5.5 y 4.x se tarifan por su entrada', () => {
    expect(getModelCosts('claude-sonnet-5-5', usage).inputTokens).toBe(3)
    expect(getModelCosts('claude-opus-5-5', usage).outputTokens).toBe(25)
    expect(getModelCosts('claude-haiku-4-5-20251001', usage).inputTokens).toBe(1)
    expect(getModelCosts('claude-3-5-haiku-20241022', usage).inputTokens).toBe(0.8)
  })

  test('un modelo futuro se reconoce como canónico sin tocar código', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-6-0')).toBe('claude-sonnet-6-0')
    expect(firstPartyNameToCanonical('claude-opus-5-5-20271001')).toBe('claude-opus-5-5')
  })
})
