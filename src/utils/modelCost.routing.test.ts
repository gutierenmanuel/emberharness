import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Catalog } from '../services/api/openai-compat/catalog.js'
import { calculateUSDCost, multimodelModelCosts } from './modelCost.js'

const catalog = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    env: [],
    npm: '',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [{ id: 'deepseek/deepseek-chat', name: 'DeepSeek', costInput: 0.3, costOutput: 1.2, reasoning: false, image: false }],
  },
} as unknown as Catalog

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never

describe('multimodelModelCosts', () => {
  test('catalog prices when known, 0 for local or unpriced models', () => {
    expect(multimodelModelCosts(catalog, 'openrouter', 'deepseek/deepseek-chat').outputTokens).toBe(1.2)
    expect(multimodelModelCosts(catalog, 'openrouter', 'unknown').inputTokens).toBe(0)
    expect(multimodelModelCosts(catalog, undefined, 'qwen36-35b').inputTokens).toBe(0)
  })
})

describe('calculateUSDCost with cuenta:modelo', () => {
  test('a subagent is priced on its own account', () => {
    const saved = { dir: process.env.CLAUDE_CONFIG_DIR, account: process.env.FNHARNESS_ACCOUNT }
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-cost-'))
    delete process.env.FNHARNESS_ACCOUNT
    try {
    // Local account (no catalog entry): free, not billed as a Claude model.
    expect(calculateUSDCost('qwen36:qwen36-35b-heretic-q4km', usage)).toBe(0)
    // Native account: Claude prices (Haiku 4.5 is $1/$5 per Mtok).
    expect(calculateUSDCost('claude:claude-haiku-4-5-20251001', usage)).toBe(calculateUSDCost('claude-haiku-4-5-20251001', usage))
    expect(calculateUSDCost('claude:claude-haiku-4-5-20251001', usage)).toBeGreaterThan(0)
    } finally {
      if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved.dir
      if (saved.account !== undefined) process.env.FNHARNESS_ACCOUNT = saved.account
    }
  })
})
