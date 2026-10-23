import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listAccounts,
  loadStore,
  profileForAccount,
  saveStore,
  startupAccountId,
} from './accounts.js'
import { setActiveProfile } from './profiles.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'fnh-')), 'accounts.json')

describe('accounts', () => {
  test('claude resolves to the native path; unknown ids throw', () => {
    expect(profileForAccount('claude', { accounts: {} }, {})).toBeNull()
    expect(() => profileForAccount('nope', { accounts: {} }, {})).toThrow(/Unknown account/)
  })

  test('stored key and model make a keyed provider ready', () => {
    const store = { accounts: { openai: { apiKey: 'sk-x', model: 'gpt-4o' } } }
    const p = profileForAccount('openai', store, {})
    expect(p?.model).toBe('gpt-4o')
    expect(p?.apiKey).toBe('sk-x')
    const openai = listAccounts(store, {}).find(a => a.id === 'openai')!
    expect(openai.ready).toBe(true)
    const missing = listAccounts({ accounts: {} }, {}).find(a => a.id === 'openai')!
    expect(missing.ready).toBe(false)
    expect(missing.detail).toMatch(/OPENAI_API_KEY/)
  })

  test('process launch env does not leak into other accounts', () => {
    const p = profileForAccount('ollama', { accounts: {} }, { CLAUDE_MULTIMODEL_MODEL: 'leaked' })
    expect(p?.model).not.toBe('leaked')
  })

  test('custom accounts are listed and the store round-trips with mode 0600', () => {
    const path = tmp()
    saveStore({ active: 'mine', accounts: { mine: { provider: 'custom', baseUrl: 'http://x/v1', label: 'mine' } } }, path)
    const store = loadStore(path)
    expect(store.active).toBe('mine')
    expect(listAccounts(store, {}).some(a => a.id === 'mine' && a.ready)).toBe(true)
    expect(startupAccountId(store, {})).toBe('mine')
    expect(startupAccountId(store, { CLAUDE_MULTIMODEL_ACCOUNT: 'groq' })).toBe('groq')
  })

  test('setActiveProfile swaps model env and restores it for claude', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_MODEL: 'orig' }
    const profile = profileForAccount('ollama', { accounts: { ollama: { model: 'qwen3:8b' } } }, {})
    setActiveProfile(profile, 'ollama', env)
    expect(env.ANTHROPIC_MODEL).toBe('qwen3:8b')
    expect(env.FNHARNESS_ACCOUNT).toBe('ollama')
    setActiveProfile(null, 'claude', env)
    expect(env.ANTHROPIC_MODEL).toBe('orig')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
  })
})
