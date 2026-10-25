import { beforeEach, describe, expect, test } from 'bun:test'
import { getModelLimits, resolveProfile } from './profiles.js'
import {
  buildAccountStatus,
  contextSource,
  getServerInfo,
  isStale,
  parseProps,
  probeServer,
  refreshServerInfo,
  resetServerInfoForTesting,
  serverRoot,
  setServerInfoForTesting,
  type AccountStatusInput,
} from './statusInfo.js'

const base: AccountStatusInput = {
  accountId: 'qwen36',
  accountLabel: 'Qwen3.6 (local)',
  provider: 'qwen36',
  baseUrl: 'http://localhost:8090/v1',
  model: 'qwen36-35b',
  contextWindow: 32768,
  contextSource: 'server',
  autoCompactAt: 29500,
  maxOutputTokens: 4096,
  server: { online: true, nCtx: 32768, model: 'qwen36-35b-heretic-q4km', checkedAt: 10_000 },
  speed: null,
  pricePerMtok: null,
  now: 13_400,
}

const reply = (status: number, body: unknown = {}) => async () => ({ status, json: async () => body })

beforeEach(() => resetServerInfoForTesting())

describe('buildAccountStatus', () => {
  test('local account: real window, server state, free cost, no Claude names', () => {
    const s = buildAccountStatus(base)
    expect(s.account).toMatchObject({ id: 'qwen36', local: true, provider: 'qwen36', server_model: 'qwen36-35b-heretic-q4km' })
    expect(s.context).toEqual({ window: 32768, source: 'server', autocompact_at: 29500, max_output_tokens: 4096 })
    expect(s.server).toEqual({ online: true, n_ctx: 32768, age_s: 3 })
    expect(s.cost).toEqual({ kind: 'free' })
    expect(JSON.stringify(s)).not.toMatch(/claude/i)
  })

  test('speed comes from the last summary in the JSON shape of local_speed', () => {
    const s = buildAccountStatus({
      ...base,
      speed: { requests: 1, ttftMs: 420, promptN: 300, cacheN: 0, promptTps: 1500, predictedN: 210, predictedTps: 42, draftN: 120, draftAccepted: 90, source: 'server' },
    })
    expect(s.speed).toMatchObject({ ttft_s: 0.42, generation_tokens_per_second: 42, prompt_tokens_per_second: 1500 })
  })

  test('native account is a subscription with no server block', () => {
    const s = buildAccountStatus({ ...base, accountId: 'claude', provider: null, baseUrl: null, contextSource: 'claude', server: null })
    expect(s.cost.kind).toBe('subscription')
    expect(s.account.local).toBe(false)
    expect(s.server).toBeNull()
  })

  test('hosted account: priced by the catalog or marked unpriced', () => {
    const hosted = { ...base, accountId: 'deepseek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', server: null }
    expect(buildAccountStatus({ ...hosted, pricePerMtok: { input: 0.27, output: 1.1 } }).cost).toEqual({ kind: 'priced', input_per_mtok: 0.27, output_per_mtok: 1.1 })
    expect(buildAccountStatus(hosted).cost.kind).toBe('unpriced')
  })

  test('server_model is null when it equals the configured model', () => {
    const s = buildAccountStatus({ ...base, model: 'x', server: { ...base.server!, model: 'x' } })
    expect(s.account.server_model).toBeNull()
  })
})

describe('contextSource', () => {
  test('precedence: claude, server, preset, catalog, default', () => {
    const c = { native: false, serverNCtx: null, presetWindow: undefined, catalogWindow: undefined }
    expect(contextSource({ ...c, native: true, serverNCtx: 1 })).toBe('claude')
    expect(contextSource({ ...c, serverNCtx: 8192, presetWindow: 32768 })).toBe('server')
    expect(contextSource({ ...c, presetWindow: 32768, catalogWindow: 1 })).toBe('preset')
    expect(contextSource({ ...c, catalogWindow: 128000 })).toBe('catalog')
    expect(contextSource(c)).toBe('default')
  })
})

describe('server probing', () => {
  test('serverRoot drops the /v1 suffix', () => {
    expect(serverRoot('http://localhost:8082/v1')).toBe('http://localhost:8082')
    expect(serverRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434')
    expect(serverRoot('http://h:1')).toBe('http://h:1')
  })

  test('parseProps reads n_ctx and the model file name from llama.cpp /props', () => {
    expect(parseProps({ default_generation_settings: { n_ctx: 32768 }, model_alias: '/m/qwen.gguf' })).toEqual({ nCtx: 32768, model: 'qwen' })
    expect(parseProps({})).toEqual({ nCtx: null, model: null })
    expect(parseProps(null)).toEqual({ nCtx: null, model: null })
  })

  test('probeServer: props ok, other 4xx online without n_ctx, 5xx and network errors offline', async () => {
    const ok = await probeServer('http://localhost:8082/v1', reply(200, { default_generation_settings: { n_ctx: 4096 } }), 5)
    expect(ok).toMatchObject({ online: true, nCtx: 4096, checkedAt: 5 })
    expect(await probeServer('http://x/v1', reply(404), 5)).toMatchObject({ online: true, nCtx: null })
    expect(await probeServer('http://x/v1', reply(503), 5)).toMatchObject({ online: false })
    const boom = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await probeServer('http://x/v1', boom, 5)).toMatchObject({ online: false })
  })

  test('TTL: online entries last longer than offline ones', () => {
    const on = { online: true, nCtx: null, model: null, checkedAt: 0 }
    expect(isStale(null, 0)).toBe(true)
    expect(isStale(on, 14_000)).toBe(false)
    expect(isStale(on, 16_000)).toBe(true)
    expect(isStale({ ...on, online: false }, 3_000)).toBe(false)
    expect(isStale({ ...on, online: false }, 5_000)).toBe(true)
  })

  test('refreshServerInfo fills the cache once, never re-probes while fresh and skips hosted APIs', async () => {
    let calls = 0
    const f = async () => {
      calls++
      return { status: 200, json: async () => ({ default_generation_settings: { n_ctx: 8192 } }) }
    }
    refreshServerInfo('http://localhost:8082/v1', {}, f, 1000)
    refreshServerInfo('http://localhost:8082/v1', {}, f, 1000) // in flight
    await Bun.sleep(20)
    expect(getServerInfo('http://localhost:8082/v1')?.nCtx).toBe(8192)
    refreshServerInfo('http://localhost:8082/v1', {}, f, 2000) // fresh
    await Bun.sleep(20)
    expect(calls).toBe(1)
    refreshServerInfo('https://api.openai.com/v1', {}, f, 1000)
    refreshServerInfo('http://localhost:9/v1', { FNHARNESS_SERVER_PROBE: '0' }, f, 1000)
    await Bun.sleep(20)
    expect(calls).toBe(1)
    expect(getServerInfo('https://api.openai.com/v1')).toBeNull()
  })
})

describe('real window feeds the limits', () => {
  const profile = resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'qwen36' })!
  const llama = resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'llamacpp' })!

  test('without a probe the preset value stands; llamacpp has none', () => {
    expect(getModelLimits(profile, 'm').contextWindow).toBe(32768)
    expect(getModelLimits(llama, 'default').contextWindow).toBeUndefined()
  })

  test('a probed n_ctx wins over the preset and fills the gap for llamacpp', () => {
    setServerInfoForTesting(profile.baseUrl, { online: true, nCtx: 65536, model: null, checkedAt: 0 })
    setServerInfoForTesting(llama.baseUrl, { online: true, nCtx: 16384, model: null, checkedAt: 0 })
    expect(getModelLimits(profile, 'm').contextWindow).toBe(65536)
    expect(getModelLimits(llama, 'default').contextWindow).toBe(16384)
  })

  test('a short window without an output cap gets a quarter of it, so auto-compact stays positive', () => {
    setServerInfoForTesting(llama.baseUrl, { online: true, nCtx: 16384, model: null, checkedAt: 0 })
    expect(getModelLimits(llama, 'default').maxOutputTokens).toBe(4096)
    // The preset's own cap is untouched, and a long window keeps the default.
    expect(getModelLimits(profile, 'm').maxOutputTokens).toBe(4096)
    setServerInfoForTesting(llama.baseUrl, { online: true, nCtx: 262144, model: null, checkedAt: 0 })
    expect(getModelLimits(llama, 'default').maxOutputTokens).toBeUndefined()
  })
})
