import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  catalogIdFor,
  compatKind,
  isUsableChatModel,
  modelLimits,
  parseCatalog,
  resolveBaseUrl,
  trimCatalog,
  usableProviders,
} from './catalog.js'
import { isCacheStale, refreshCatalog } from './catalogStore.js'
import { getModelLimits, resolveProfile } from './profiles.js'

const raw = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    env: ['DEEPSEEK_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.deepseek.com/',
    models: {
      'deepseek-chat': { id: 'deepseek-chat', name: 'DeepSeek Chat', tool_call: true, limit: { context: 128000, output: 8000 }, cost: { input: 0.3, output: 1.2 }, release_date: '2026-01-01' },
      'deepseek-old': { id: 'deepseek-old', name: 'Old', tool_call: true, status: 'deprecated', limit: { context: 1, output: 1 } },
      'deepseek-notools': { id: 'deepseek-notools', name: 'NT', tool_call: false, limit: { context: 1, output: 1 } },
      'deepseek-embed': { id: 'deepseek-embed', name: 'E', type: 'embedding', tool_call: true },
      'deepseek-resp': { id: 'deepseek-resp', name: 'R', tool_call: true, provider: { shape: 'responses' } },
    },
  },
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], npm: '@ai-sdk/openai', models: { 'gpt-x': { name: 'GPT X', tool_call: true, limit: { context: 400000, output: 128000 } } } },
  google: { id: 'google', name: 'Google', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], npm: '@ai-sdk/google', models: { g: { name: 'G', tool_call: true, modalities: { input: ['text', 'image'] } } } },
  anthropic: { id: 'anthropic', name: 'Anthropic', npm: '@ai-sdk/anthropic', models: { c: { name: 'C', tool_call: true } } },
  bedrock: { id: 'bedrock', name: 'Bedrock', npm: '@ai-sdk/amazon-bedrock', models: { b: { name: 'B', tool_call: true } } },
}

describe('catalog parsing', () => {
  test('filters chat models with tools, not deprecated, not responses-only', () => {
    expect(isUsableChatModel(raw.deepseek.models['deepseek-chat'])).toBe(true)
    expect(isUsableChatModel(raw.deepseek.models['deepseek-old'])).toBe(false)
    expect(isUsableChatModel(raw.deepseek.models['deepseek-notools'])).toBe(false)
    expect(isUsableChatModel(raw.deepseek.models['deepseek-embed'])).toBe(false)
    expect(isUsableChatModel(raw.deepseek.models['deepseek-resp'])).toBe(false)
    const c = parseCatalog(raw)
    expect(c.deepseek!.models.map(m => m.id)).toEqual(['deepseek-chat'])
    expect(c.deepseek!.models[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8000, costInput: 0.3 })
  })

  test('maps providers to base URLs and kinds', () => {
    expect(resolveBaseUrl('deepseek', raw.deepseek)).toBe('https://api.deepseek.com')
    expect(resolveBaseUrl('openai', raw.openai)).toBe('https://api.openai.com/v1')
    expect(resolveBaseUrl('google', raw.google)).toContain('generativelanguage')
    expect(compatKind('anthropic', raw.anthropic)).toBe('anthropic')
    expect(compatKind('bedrock', raw.bedrock)).toBe('other')
    expect(resolveBaseUrl('bedrock', raw.bedrock)).toBeNull()
    expect(catalogIdFor('gemini')).toBe('google')
    expect(catalogIdFor('together')).toBe('togetherai')
    expect(catalogIdFor('groq')).toBe('groq')
  })

  test('usableProviders keeps only OpenAI-compatible, biggest first', () => {
    const ids = usableProviders(parseCatalog(raw)).map(p => p.id)
    expect(ids.sort()).toEqual(['deepseek', 'google', 'openai'])
  })

  test('trimCatalog drops other protocols and unused fields, and re-parses equal', () => {
    const t = trimCatalog(raw)
    expect(Object.keys(t).sort()).toEqual(['deepseek', 'google', 'openai'])
    expect(Object.keys(t.deepseek!.models!)).toEqual(['deepseek-chat'])
    expect(parseCatalog(t).deepseek!.models[0]).toMatchObject({ id: 'deepseek-chat', contextWindow: 128000 })
    expect(parseCatalog(t).google!.models[0]!.image).toBe(true)
  })
})

describe('limits and profiles', () => {
  const catalog = parseCatalog(raw)
  test('modelLimits reads the catalog; explicit profile values win', () => {
    expect(modelLimits(catalog, 'deepseek', 'deepseek-chat')).toEqual({ contextWindow: 128000, maxOutputTokens: 8000 })
    expect(modelLimits(catalog, 'deepseek', 'nope')).toBeUndefined()
    const p = resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'deepseek', CLAUDE_MULTIMODEL_API_KEY: 'k' }, catalog)!
    expect(getModelLimits(p, 'deepseek-chat', catalog).contextWindow).toBe(128000)
    expect(getModelLimits({ ...p, contextWindow: 32768 }, 'deepseek-chat', catalog).contextWindow).toBe(32768)
  })

  test('local presets keep their own limits and no catalog provider', () => {
    const q = resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'qwen36' }, catalog)!
    expect(q.catalogProvider).toBeUndefined()
    expect(getModelLimits(q, 'whatever', catalog)).toEqual({ contextWindow: 32768, maxOutputTokens: 4096 })
  })

  test('a catalog provider that is not a preset resolves with its env key', () => {
    const cat = parseCatalog({ ...raw, acme: { name: 'Acme', env: ['ACME_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://acme.test/v1', models: { m1: { name: 'M1', tool_call: true } } } })
    const p = resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'acme', ACME_KEY: 'k' }, cat)!
    expect(p).toMatchObject({ baseUrl: 'https://acme.test/v1', model: 'm1', apiKey: 'k', catalogProvider: 'acme' })
    expect(() => resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'acme' }, cat)).toThrow(/API key/)
    expect(() => resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'bedrock' }, cat)).toThrow(/Unknown provider/)
  })
})

describe('cache refresh', () => {
  const okFetch = (body: unknown) => async () => ({ ok: true, json: async () => body })
  test('stale rule and refresh writes a trimmed cache', async () => {
    expect(isCacheStale(null)).toBe(true)
    expect(isCacheStale({ fetchedAt: 1000, catalog: {} }, 1000 + 1000)).toBe(false)
    expect(isCacheStale({ fetchedAt: 0, catalog: {} }, 25 * 3600 * 1000)).toBe(true)

    const dir = mkdtempSync(join(tmpdir(), 'fnh-cat-'))
    const env = { CLAUDE_CONFIG_DIR: dir }
    expect(await refreshCatalog(env, okFetch(raw), 5000)).toBe(true)
    const written = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))
    expect(written.fetchedAt).toBe(5000)
    expect(Object.keys(written.catalog).sort()).toEqual(['deepseek', 'google', 'openai'])
    // fresh cache: no second fetch
    expect(await refreshCatalog(env, async () => { throw new Error('no') }, 6000)).toBe(false)
  })

  test('failures and the disable flag leave things alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-cat-'))
    expect(await refreshCatalog({ CLAUDE_CONFIG_DIR: dir }, async () => { throw new Error('offline') })).toBe(false)
    expect(await refreshCatalog({ CLAUDE_CONFIG_DIR: dir, FNHARNESS_DISABLE_MODELS_FETCH: '1' }, okFetch(raw))).toBe(false)
    writeFileSync(join(dir, 'x'), '')
  })
})
