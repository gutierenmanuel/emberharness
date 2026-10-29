import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  expandKeyRefTemplate,
  getProviderPresets,
  mergeProviders,
  providerKeyRef,
  providerModelOverride,
  resetProvidersForTesting,
} from './providers.js'

const savedDir = process.env.CLAUDE_CONFIG_DIR
beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-pr-'))
  resetProvidersForTesting()
})
afterEach(() => {
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedDir
  resetProvidersForTesting()
})

describe('defaults', () => {
  test('traen los presets de siempre', () => {
    const p = getProviderPresets()
    expect(p.venice?.baseUrl).toBe('https://api.venice.ai/api/v1')
    expect(p.qwen36?.contextWindow).toBe(32768)
    expect(p.openai?.maxTokensParam).toBe('max_completion_tokens')
    expect(p.custom?.keyOptional).toBe(true)
  })

  test('sin plantilla ni keyRef no hay referencia de clave', () => {
    expect(providerKeyRef('venice')).toBeUndefined()
  })
})

describe('mergeProviders', () => {
  const defaults = () => ({ providers: getProviderPresets() })

  test('ajusta un preset campo a campo y añade overrides por modelo', () => {
    const m = mergeProviders(defaults(), {
      providers: {
        venice: { keyRef: 'pass:apis/venice', models: { 'deepseek-v4-1-flash-1017': { contextWindow: 1_000_000, pricing: { input: 0.5, output: 1.5 } } } },
      },
    })
    expect(m.providers.venice?.baseUrl).toBe('https://api.venice.ai/api/v1')
    expect(m.providers.venice?.keyRef).toBe('pass:apis/venice')
    expect(m.providers.venice?.models?.['deepseek-v4-1-flash-1017']?.pricing?.outputTokens).toBe(1.5)
  })

  test('un proveedor nuevo exige baseUrl', () => {
    const m = mergeProviders(defaults(), { providers: { nuevo: { baseUrl: 'http://x/v1', defaultModel: 'm' }, roto: { label: 'sin url' } } })
    expect(m.providers.nuevo?.defaultModel).toBe('m')
    expect(m.providers.nuevo?.keyOptional).toBe(false)
    expect(m.providers.roto).toBeUndefined()
  })

  test('la plantilla de clave se expande por proveedor', () => {
    expect(expandKeyRefTemplate('pass:apis/{provider}', 'groq')).toBe('pass:apis/groq')
    expect(() => mergeProviders(defaults(), 3)).toThrow()
  })
})

describe('hot reload desde el fichero de usuario', () => {
  test('providers.json aplica plantilla, keyRef propio y overrides', () => {
    writeFileSync(
      join(process.env.CLAUDE_CONFIG_DIR!, 'providers.json'),
      JSON.stringify({
        keyRefTemplate: 'pass:apis/{provider}',
        providers: { groq: { keyRef: 'pass:otro/groq', models: { m: { contextWindow: 7 } } } },
      }),
    )
    resetProvidersForTesting()
    expect(providerKeyRef('deepseek')).toBe('pass:apis/deepseek')
    expect(providerKeyRef('groq')).toBe('pass:otro/groq')
    expect(providerModelOverride('groq', 'm')?.contextWindow).toBe(7)
  })
})
