import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accountsFilePath, loadStore, saveStore } from '../../services/api/openai-compat/accounts.js'
import { resetActiveProfileForTesting } from '../../services/api/openai-compat/profiles.js'
import { formatAccountLine, removeAccount, setDefaultAccount, startupSummary, switchAccount } from './actions.js'

const sandbox = () => ({ CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-def-')) }) as Record<string, string | undefined>

describe('/account default', () => {
  // switchAccount primes module-level profile state; do not leak it to other files.
  afterEach(() => resetActiveProfileForTesting())

  test('fixes the account and its model, and switching later does not move it', () => {
    const env = sandbox()
    const r = setDefaultAccount('qwen36', 'otro-modelo', env)
    expect(r.message).toMatch(/predeterminada.*qwen36.*otro-modelo/)
    let store = loadStore(accountsFilePath(env))
    expect(store.default).toBe('qwen36')
    expect(store.accounts.qwen36?.model).toBe('otro-modelo')
    switchAccount('ollama', undefined, { ...env })
    store = loadStore(accountsFilePath(env))
    expect(store.active).toBe('ollama')
    expect(store.default).toBe('qwen36')
    expect(startupSummary(env)).toMatch(/Al abrir: qwen36 \(predeterminada/)
  })

  test('last clears it and the summary falls back to the last used account', () => {
    const env = sandbox()
    setDefaultAccount('qwen36', undefined, env)
    setDefaultAccount('last', undefined, env)
    expect(loadStore(accountsFilePath(env)).default).toBeUndefined()
    expect(startupSummary(env)).toMatch(/Al abrir: claude \(última usada/)
  })

  test('unknown account or one missing its key is refused and nothing is written', () => {
    const env = sandbox()
    expect(() => setDefaultAccount('nope', undefined, env)).toThrow(/Unknown account/)
    expect(() => setDefaultAccount('openai', undefined, env)).toThrow(/API key/)
    expect(loadStore(accountsFilePath(env)).default).toBeUndefined()
  })

  test('removing the default account clears the default', () => {
    const env = sandbox()
    saveStore({ default: 'mine', accounts: { mine: { provider: 'custom', baseUrl: 'http://x/v1' } } }, accountsFilePath(env))
    removeAccount('mine', env)
    expect(loadStore(accountsFilePath(env)).default).toBeUndefined()
  })

  test('the list marks the default', () => {
    const a = { id: 'qwen36', label: 'Q', provider: 'qwen36', baseUrl: 'http://localhost:8090/v1', ready: true, detail: 'd' }
    expect(formatAccountLine(a, 'claude', 'qwen36')).toContain('[predeterminada]')
    expect(formatAccountLine(a, 'claude', 'ollama')).not.toContain('[predeterminada]')
  })
})
