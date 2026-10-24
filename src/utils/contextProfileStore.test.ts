import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadContextProfileForAccount, resolveInitialContextProfile, saveContextProfileForAccount } from './contextProfileStore.js'

const sandbox = (accounts: object = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnh-ctx-'))
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ accounts }))
  return { CLAUDE_CONFIG_DIR: dir } as Record<string, string | undefined>
}

describe('context profile per account', () => {
  test('defaults: local presets → Simple, hosted → Full', () => {
    const env = sandbox()
    expect(loadContextProfileForAccount('qwen36', env)).toEqual({ mcp: 'none', skill: 'none', tools: 'simple' })
    expect(loadContextProfileForAccount('llamacpp', env)).toEqual({ mcp: 'none', skill: 'none', tools: 'simple' })
    expect(loadContextProfileForAccount('openrouter', { ...env, OPENROUTER_API_KEY: 'x' })).toEqual({ mcp: 'full', skill: 'full', tools: 'full' })
  })
  test('a saved profile wins and is written back to accounts.json', () => {
    const env = sandbox({ qwen36: { model: 'm' } })
    saveContextProfileForAccount('qwen36', { mcp: 'user', skill: 'none', tools: 'full' }, env)
    const stored = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR!, 'accounts.json'), 'utf8'))
    expect(stored.accounts.qwen36).toEqual({ model: 'm', contextProfile: { mcp: 'user', skill: 'none', tools: 'full' } })
    expect(loadContextProfileForAccount('qwen36', env)).toEqual({ mcp: 'user', skill: 'none', tools: 'full' })
  })
  test('FNHARNESS_CONTEXT_PROFILE forces the launch profile', () => {
    const env = { ...sandbox(), FNHARNESS_ACCOUNT: 'qwen36', FNHARNESS_CONTEXT_PROFILE: 'nothing' }
    expect(resolveInitialContextProfile(env)).toEqual({ mcp: 'none', skill: 'none', tools: 'none' })
  })
})
