import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accountsFilePath, loadStore, profileForAccount, saveStore } from '../../services/api/openai-compat/accounts.js'
import { resetActiveProfileForTesting } from '../../services/api/openai-compat/profiles.js'
import { clearSecretCache, setRunnerForTesting, type Ctx, type Runner } from '../../services/secrets/secrets.js'
import { moveSecret, removeSecret, secretRows, setSecret, testSecret, useSecret } from './actions.js'

function sandbox(extra: Record<string, string> = {}) {
  const pass = new Map<string, string>()
  const run: Runner = (cmd, args, input) => {
    if (cmd !== 'pass') return { status: 1, stdout: '', stderr: 'no tool' }
    if (args[0] === '--version') return { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'show') return pass.has(args[1]!) ? { status: 0, stdout: pass.get(args[1]!)! + '\n', stderr: '' } : { status: 1, stdout: '', stderr: 'missing' }
    if (args[0] === 'insert') { pass.set(args[3]!, input!.trim()); return { status: 0, stdout: '', stderr: '' } }
    if (args[0] === 'rm') { pass.delete(args[2]!); return { status: 0, stdout: '', stderr: '' } }
    return { status: 1, stdout: '', stderr: '' }
  }
  const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-sa-')), PASSWORD_STORE_DIR: mkdtempSync(join(tmpdir(), 'fnh-ps-')), ...extra }
  const ctx: Ctx = { env, run }
  // accounts.ts resolves references through the default context: keep it away from the real pass.
  setRunnerForTesting(run)
  return { env, ctx, pass }
}

describe('/secrets actions', () => {
  beforeEach(() => clearSecretCache())
  afterEach(() => {
    resetActiveProfileForTesting()
    setRunnerForTesting(null)
  })

  test('set stores in the gestor, links the account and drops a legacy literal key', () => {
    const { env, ctx, pass } = sandbox()
    saveStore({ accounts: { venice: { apiKey: 'legacy-key' } } }, accountsFilePath(env))
    const r = setSecret('venice', 'pass', 'new-key', undefined, env, ctx)
    expect(r.message).toContain('pass:apis/venice')
    expect(r.message).not.toContain('new-key')
    expect(pass.get('apis/venice')).toBe('new-key')
    const stored = loadStore(accountsFilePath(env)).accounts.venice!
    expect(stored.apiKeyRef).toBe('pass:apis/venice')
    expect(stored.apiKey).toBeUndefined()
  })

  test('the profile gets its key from the reference; an exported provider variable wins over it', () => {
    const { env, ctx, pass } = sandbox()
    pass.set('apis/venice', 'pass-key')
    saveStore({ accounts: { venice: { apiKeyRef: 'pass:apis/venice' } } }, accountsFilePath(env))
    const store = loadStore(accountsFilePath(env))
    expect(profileForAccount('venice', store, env)?.apiKey).toBe('pass-key')
    expect(profileForAccount('venice', store, { ...env, VENICE_API_KEY: 'env-key' })?.apiKey).toBe('env-key')
  })

  test('an unreadable reference aborts with the reason, not with a generic missing-key error', () => {
    const { env } = sandbox()
    saveStore({ accounts: { venice: { apiKeyRef: 'file:no-existe' } } }, accountsFilePath(env))
    expect(() => profileForAccount('venice', loadStore(accountsFilePath(env)), env)).toThrow(/No se pudo leer la clave de "venice" \(file:no-existe\)/)
  })

  test('use verifies the secret is readable before linking', () => {
    const { env, ctx, pass } = sandbox()
    expect(() => useSecret('venice', 'pass:apis/venice', env, ctx)).toThrow(/pass show/)
    expect(loadStore(accountsFilePath(env)).accounts.venice?.apiKeyRef).toBeUndefined()
    pass.set('apis/venice', 'k')
    expect(useSecret('venice', 'pass:apis/venice', env, ctx).message).toContain('leída con éxito')
  })

  test('move carries the value to the new gestor and deletes the old copy', () => {
    const { env, ctx, pass } = sandbox()
    pass.set('apis/venice', 'k1')
    useSecret('venice', 'pass:apis/venice', env, ctx)
    const r = moveSecret('venice', 'file', undefined, env, ctx)
    expect(r.message).toContain('file:venice')
    expect(pass.has('apis/venice')).toBe(false)
    expect(loadStore(accountsFilePath(env)).accounts.venice?.apiKeyRef).toBe('file:venice')
  })

  test('move from a literal key removes it from accounts.json', () => {
    const { env, ctx, pass } = sandbox()
    saveStore({ accounts: { groq: { apiKey: 'lit' } } }, accountsFilePath(env))
    moveSecret('groq', 'pass', undefined, env, ctx)
    expect(pass.get('apis/groq')).toBe('lit')
    expect(loadStore(accountsFilePath(env)).accounts.groq?.apiKey).toBeUndefined()
  })

  test('rm unlinks without touching the value; --purge deletes it too', () => {
    const { env, ctx, pass } = sandbox()
    pass.set('apis/venice', 'k')
    useSecret('venice', 'pass:apis/venice', env, ctx)
    removeSecret('venice', false, env, ctx)
    expect(pass.has('apis/venice')).toBe(true)
    useSecret('venice', 'pass:apis/venice', env, ctx)
    removeSecret('venice', true, env, ctx)
    expect(pass.has('apis/venice')).toBe(false)
    expect(loadStore(accountsFilePath(env)).accounts.venice?.apiKeyRef).toBeUndefined()
  })

  test('claude and unknown accounts are refused', () => {
    const { env, ctx } = sandbox()
    expect(() => setSecret('claude', 'file', 'x', undefined, env, ctx)).toThrow(/\/login/)
    expect(() => setSecret('nope', 'file', 'x', undefined, env, ctx)).toThrow(/desconocida/)
  })

  test('rows show source and state, skip local servers, and flag legacy plaintext keys', () => {
    const { env, ctx, pass } = sandbox({ GROQ_API_KEY: 'exported' })
    pass.set('apis/venice', 'k')
    saveStore({ accounts: { venice: { apiKeyRef: 'pass:apis/venice' }, openai: { apiKey: 'lit' } } }, accountsFilePath(env))
    const rows = secretRows(env, ctx)
    const by = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(by.ollama).toBeUndefined()
    expect(by.llamacpp).toBeUndefined()
    expect(by.groq?.source).toBe('env')
    expect(by.openai?.source).toBe('legacy')
    expect(by.mistral?.source).toBe('none')
    expect(by.venice?.source).toBe('ref')
    expect(JSON.stringify(rows)).not.toMatch(/exported|"lit"/)
  })

  test('test reports length and HTTP status but never the key', async () => {
    const { env, ctx, pass } = sandbox()
    pass.set('apis/venice', 'abcdef')
    useSecret('venice', 'pass:apis/venice', env, ctx)
    const fake = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const r = await testSecret('venice', env, fake)
    expect(r.message).toContain('6 caracteres')
    expect(r.message).toContain('HTTP 200')
    expect(r.message).not.toContain('abcdef')
  })
})
