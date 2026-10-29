import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadCatalog, resetCatalogMemo } from './catalogStore.js'
import { modelLimits } from './catalog.js'

beforeEach(() => resetCatalogMemo())
afterEach(() => resetCatalogMemo())

describe('loadCatalog', () => {
  test('completa con el snapshot los proveedores que la caché no trae (Venice)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-cat-'))
    // Caché reciente que models.dev ya no sirve con Venice.
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        fetchedAt: Date.now(),
        catalog: {
          openai: {
            id: 'openai',
            name: 'OpenAI',
            env: ['OPENAI_API_KEY'],
            npm: '@ai-sdk/openai',
            models: { 'gpt-x': { name: 'GPT X', tool_call: true, limit: { context: 123456, output: 4096 } } },
          },
        },
      }),
    )
    const catalog = loadCatalog({ CLAUDE_CONFIG_DIR: dir })
    expect(modelLimits(catalog, 'openai', 'gpt-x')?.contextWindow).toBe(123456)
    expect(modelLimits(catalog, 'venice', 'deepseek-v4-1-flash-1017')?.contextWindow).toBe(1_000_000)
  })
})
