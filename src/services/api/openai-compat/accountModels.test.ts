import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearAccountModelsCache,
  countModels,
  describeModel,
  listAccountModels,
  mergeModels,
  parseServerModelIds,
  type ModelTarget,
} from './accountModels.js'
import { parseCatalog } from './catalog.js'
import { addAccount, catalogLines } from '../../../commands/account/actions.js'

const catalog = parseCatalog({
  deepseek: { name: 'DeepSeek', env: ['DEEPSEEK_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://api.deepseek.com/v1', models: { a: { name: 'A', tool_call: true, limit: { context: 128000, output: 8000 }, release_date: '2026-02-01' }, b: { name: 'B', tool_call: true, release_date: '2026-03-01' } } },
  lmstudio: { name: 'LM Studio', env: [], npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:1234/v1', models: { sample: { name: 'Sample', tool_call: true, limit: { context: 4096, output: 512 } } } },
  bedrock: { name: 'Bedrock', npm: '@ai-sdk/amazon-bedrock', models: { x: { name: 'X', tool_call: true } } },
})

const hosted: ModelTarget = { id: 'deepseek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', catalogProvider: 'deepseek' }
const local: ModelTarget = { id: 'llamacpp', provider: 'llamacpp', baseUrl: 'http://localhost:8082/v1' }

const fakeFetch = (body: unknown, calls: string[] = []) =>
  (async (url: string) => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => body }
  }) as unknown as typeof fetch

beforeEach(() => clearAccountModelsCache())

describe('listAccountModels', () => {
  test('parses OpenAI and llama.cpp shaped responses', () => {
    expect(parseServerModelIds({ data: [{ id: 'm1' }, { id: 'm1' }, { id: 'm2' }] })).toEqual(['m1', 'm2'])
    expect(parseServerModelIds({ models: [{ model: 'q' }] })).toEqual(['q'])
    expect(parseServerModelIds(null)).toEqual([])
  })

  test('hosted: catalog union server ids, catalog first', async () => {
    const calls: string[] = []
    const models = await listAccountModels(hosted, { catalog, fetchImpl: fakeFetch({ data: [{ id: 'a' }, { id: 'extra' }] }, calls) })
    expect(models.map(m => m.id)).toEqual(['b', 'a', 'extra'])
    expect(models.find(m => m.id === 'extra')!.source).toBe('server')
    expect(calls).toEqual(['https://api.deepseek.com/v1/models'])
  })

  test('local: the server is the only source; ids matching the catalog are enriched', async () => {
    const t: ModelTarget = { id: 'lmstudio', provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', catalogProvider: 'lmstudio' }
    const models = await listAccountModels(t, { catalog, fetchImpl: fakeFetch({ data: [{ id: 'sample' }, { id: 'real' }] }) })
    expect(models.map(m => m.id)).toEqual(['sample', 'real'])
    expect(models[0]!.contextWindow).toBe(4096)
    expect((await listAccountModels(local, { catalog, fetchImpl: fakeFetch({ data: [] }) })).length).toBe(0)
  })

  test('server failure falls back to the catalog; result is cached per account', async () => {
    const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect((await listAccountModels(hosted, { catalog, fetchImpl: boom })).map(m => m.id)).toEqual(['b', 'a'])
    const calls: string[] = []
    await listAccountModels(hosted, { catalog, fetchImpl: fakeFetch({ data: [] }, calls) })
    expect(calls).toEqual([]) // served from cache
  })

  test('remote:false never queries a hosted server but does query local ones', async () => {
    const calls: string[] = []
    const f = fakeFetch({ data: [{ id: 'z' }] }, calls)
    expect((await listAccountModels(hosted, { catalog, fetchImpl: f, remote: false })).length).toBe(2)
    expect((await listAccountModels(local, { catalog, fetchImpl: f, remote: false })).map(m => m.id)).toEqual(['z'])
    expect(calls).toEqual(['http://localhost:8082/v1/models'])
  })

  test('mergeModels + describeModel', () => {
    expect(mergeModels(hosted, [], catalog).length).toBe(2)
    expect(describeModel({ id: 'x', name: 'x', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1.2, costOutput: 4.8, reasoning: true, image: false }))
      .toBe('128k ctx · 16k out · $1.2/$4.8 por M · razonamiento')
    expect(describeModel({ id: 'x', name: 'x', reasoning: false, image: false })).toBe('sin datos del catálogo')
  })

  test('countModels sums connected accounts', async () => {
    const store = { accounts: { deepseek: { apiKey: 'k' } } }
    const n = await countModels(['deepseek', 'claude'], store, {}, { catalog, remote: false })
    expect(n).toBeGreaterThan(0)
  })
})

describe('/account catalog and add', () => {
  test('catalogLines lists usable providers with counts and filters', () => {
    const all = catalogLines(catalog)
    expect(all.join('\n')).toContain('deepseek')
    expect(all.join('\n')).toMatch(/2 modelos/)
    expect(all.join('\n')).toContain('otro protocolo')
    expect(catalogLines(catalog, 'lm').join('\n')).not.toContain('deepseek ')
  })

  test('add <catalog provider> stores the account without a URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-add-'))
    const env = { CLAUDE_CONFIG_DIR: dir }
    // deepseek is a built-in preset, so use a non-preset provider
    const cat = parseCatalog({ acme: { name: 'Acme', env: ['ACME_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://acme.test/v1', models: { m: { name: 'M', tool_call: true } } }, bedrock: { name: 'Bedrock', npm: '@ai-sdk/amazon-bedrock', models: {} } })
    const r = addAccount('acme', undefined, undefined, env, cat)
    expect(r.message).toContain('ACME_KEY')
    expect(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).accounts.acme).toMatchObject({ provider: 'acme', label: 'Acme' })
    expect(() => addAccount('bedrock', undefined, undefined, env, cat)).toThrow(/otro|SDK/)
    expect(() => addAccount('deepseek', undefined, undefined, env, catalog)).toThrow(/integrada/)
    expect(() => addAccount('nope', undefined, undefined, env, cat)).toThrow(/catálogo/)
    // classic form still works
    expect(addAccount('mine', 'http://x.test/v1', 'm1', env, cat).message).toContain('http://x.test/v1')
  })
})
