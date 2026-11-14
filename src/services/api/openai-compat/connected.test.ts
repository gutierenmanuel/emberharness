import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetProvidersForTesting } from '../../config/providers.js'
import { clearSecretCache, setRunnerForTesting, type Runner } from '../../secrets/secrets.js'
import { applyMockOverride, computeConnectedSummary, connectedAccountIds, formatConnectedLine, isAccountConnected } from './connected.js'

// Presets come from providers.json: keep the developer's real one out of these tests.
const savedDir = process.env.CLAUDE_CONFIG_DIR
beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-conn-'))
  resetProvidersForTesting()
})
afterEach(() => {
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedDir
  resetProvidersForTesting()
})

describe('connected accounts', () => {
  test('rule: ready, and local servers must answer', () => {
    expect(isAccountConnected({ ready: false, baseUrl: 'https://x/v1' })).toBe(false)
    expect(isAccountConnected({ ready: true, baseUrl: 'https://x/v1' })).toBe(true)
    expect(isAccountConnected({ ready: true, baseUrl: null })).toBe(true)
    expect(isAccountConnected({ ready: true, baseUrl: 'http://localhost:8082/v1' }, false)).toBe(false)
    expect(isAccountConnected({ ready: true, baseUrl: 'http://localhost:8082/v1' }, true)).toBe(true)
  })

  test('connectedAccountIds probes only local servers', async () => {
    const probed: string[] = []
    const ids = await connectedAccountIds(
      { GROQ_API_KEY: 'k' },
      { store: { accounts: {} }, probe: async url => (probed.push(url), url.includes(':8090')) },
    )
    expect(ids.sort()).toEqual(['claude', 'groq', 'qwen36'])
    expect(probed.every(u => u.startsWith('http://localhost'))).toBe(true)
  })

  test('the header counters never decrypt a pass reference (no gpg at startup)', async () => {
    const store = mkdtempSync(join(tmpdir(), 'fnh-pass-'))
    mkdirSync(join(store, 'apis'), { recursive: true })
    writeFileSync(join(store, 'apis', 'present.gpg'), 'x')
    const calls: string[] = []
    const runner: Runner = (cmd, args) => (calls.push(`${cmd} ${args.join(' ')}`), { status: 0, stdout: 'real-key\n', stderr: '' })
    setRunnerForTesting(runner)
    try {
      const env = { PASSWORD_STORE_DIR: store }
      const accounts = {
        okacct: { provider: 'custom', baseUrl: 'https://x.example/v1', model: 'm', apiKeyRef: 'pass:apis/present' },
        gone: { provider: 'custom', baseUrl: 'https://y.example/v1', model: 'm', apiKeyRef: 'pass:apis/absent' },
      }
      const ids = await connectedAccountIds(env, { store: { accounts }, probe: async () => false })
      expect(ids).toContain('okacct')
      expect(ids).not.toContain('gone')
      expect(calls.filter(c => c.startsWith('pass show'))).toEqual([])
    } finally {
      setRunnerForTesting(null)
      clearSecretCache()
    }
  })

  test('summary counts accounts and models; offline locals are excluded', async () => {
    const s = await computeConnectedSummary({}, { store: { accounts: {} }, probe: async () => false })
    expect(s).toEqual({ accounts: 1, models: 0 }) // only claude
  })

  test('formatting and mock override', () => {
    expect(formatConnectedLine(null)).toBe('… cuentas conectadas · … modelos')
    expect(formatConnectedLine({ accounts: 3, models: 47 })).toBe('3 cuentas conectadas · 47 modelos')
    expect(formatConnectedLine({ accounts: 1, models: 1 })).toBe('1 cuenta conectada · 1 modelo')
    expect(applyMockOverride(null, {})).toBeNull()
    expect(applyMockOverride(null, { accounts: 5, models: 9 })).toEqual({ accounts: 5, models: 9 })
    expect(applyMockOverride({ accounts: 1, models: 2 }, { models: 99 })).toEqual({ accounts: 1, models: 99 })
  })
})
