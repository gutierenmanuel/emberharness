import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accountKind, isAnthropicAccount, listAccounts, loadStore, profileForAccount } from '../api/openai-compat/accounts.js'
import { routeForModel, resetAccountRoutingForTesting, withModelRoute } from '../api/accountRouting.js'
import {
  anthropicAccountStatus,
  auditAccountPermissions,
  fixAccountPermissions,
  importAnthropicAccount,
  isFresherToken,
  logoutAnthropicAccount,
  migrateRootClaudeAccount,
  permissionFinding,
  readAccountInfo,
  readAccountTokens,
  tokenAccountId,
  writeAccountTokens,
} from './anthropicAccounts.js'
import { activeAnthropicAccountId, resetSessionAccountsForTesting } from './sessionAccounts.js'

const far = Date.now() + 3600_000
const oauth = (token: string, extra: object = {}) => ({
  claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: far, scopes: ['user:inference'], subscriptionType: 'team', ...extra },
})

let dir: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fnh-acct-'))
  saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, FNHARNESS_ACCOUNT: process.env.FNHARNESS_ACCOUNT, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.FNHARNESS_ACCOUNT
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  resetSessionAccountsForTesting()
  resetAccountRoutingForTesting()
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetSessionAccountsForTesting()
  resetAccountRoutingForTesting()
})

const env = () => ({ CLAUDE_CONFIG_DIR: dir })
const writeRoot = () => {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(oauth('root-token')), { mode: 0o600 })
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u1', emailAddress: 'yo@personal.test', organizationName: null } }))
  writeFileSync(join(dir, 'remote-settings.json'), JSON.stringify({ env: { OTEL_METRICS_EXPORTER: 'otlp' } }))
}

describe('kind', () => {
  test('a stored account without kind is openai_compat; claude and kind anthropic are Claude accounts', () => {
    expect(accountKind(undefined)).toBe('openai_compat')
    expect(accountKind({ provider: 'custom' })).toBe('openai_compat')
    const store = { accounts: { qwen: { provider: 'custom', baseUrl: 'http://x/v1' }, 'claude-work': { kind: 'anthropic' as const } } }
    expect(isAnthropicAccount('claude', store)).toBe(true)
    expect(isAnthropicAccount('claude-work', store)).toBe(true)
    expect(isAnthropicAccount('qwen', store)).toBe(false)
    expect(profileForAccount('claude-work', store, {})).toBeNull()
    expect(listAccounts(store, {}).find(a => a.id === 'claude-work')?.provider).toBeNull()
  })
})

describe('migration', () => {
  test('copies the root login into accounts/claude/ once, leaving the root intact', () => {
    writeRoot()
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8')
    const r1 = migrateRootClaudeAccount(env())
    expect(r1.migrated).toBe(true)
    expect(r1.copied.sort()).toEqual(['credentials', 'oauthAccount', 'remoteSettings'])
    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(before)
    const copy = join(dir, 'accounts', 'claude', 'credentials.json')
    expect(JSON.parse(readFileSync(copy, 'utf8')).claudeAiOauth.accessToken).toBe('root-token')
    expect(statSync(copy).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'accounts', 'claude')).mode & 0o777).toBe(0o700)
    expect(loadStore(join(dir, 'accounts.json')).accounts.claude?.kind).toBe('anthropic')
    // Idempotent: a second run changes nothing.
    const r2 = migrateRootClaudeAccount(env())
    expect(r2).toEqual({ migrated: false, reason: 'already', copied: [] })
  })

  test('nothing to migrate without root credentials, or when a Claude account exists', () => {
    expect(migrateRootClaudeAccount(env()).reason).toBe('no-root-credentials')
    writeRoot()
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ accounts: { otra: { kind: 'anthropic' } } }))
    expect(migrateRootClaudeAccount(env()).reason).toBe('already')
    expect(existsSync(join(dir, 'accounts', 'claude'))).toBe(false)
  })
})

describe('import and logout', () => {
  test('import copies another dir read-only; logout deletes only that account', () => {
    const src = mkdtempSync(join(tmpdir(), 'fnh-src-'))
    writeFileSync(join(src, '.credentials.json'), JSON.stringify(oauth('work-token')))
    writeFileSync(join(src, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u2', emailAddress: 'yo@work.test', organizationName: 'Acme' } }))
    writeFileSync(join(src, 'policy-limits.json'), JSON.stringify({ restrictions: { x: { allowed: false } } }))
    const srcBefore = readFileSync(join(src, '.credentials.json'), 'utf8')
    const r = importAnthropicAccount(src, 'claude-work', env())
    expect(r).toMatchObject({ id: 'claude-work', email: 'yo@work.test', org: 'Acme' })
    expect(readFileSync(join(src, '.credentials.json'), 'utf8')).toBe(srcBefore)
    expect(readAccountTokens('claude-work', env())?.accessToken).toBe('work-token')
    expect(() => importAnthropicAccount(src, 'claude-work', env())).toThrow(/Ya existe/)
    expect(() => importAnthropicAccount(src, '../x', env())).toThrow(/no vale/)
    expect(() => logoutAnthropicAccount('claude', env())).toThrow(/logout sin argumentos/)
    expect(() => logoutAnthropicAccount('claude-work', { ...env(), FNHARNESS_ACCOUNT: 'claude-work' })).toThrow(/cuenta de esta sesión/)
    logoutAnthropicAccount('claude-work', env())
    expect(existsSync(join(dir, 'accounts', 'claude-work'))).toBe(false)
    expect(loadStore(join(dir, 'accounts.json')).accounts['claude-work']).toBeUndefined()
    expect(existsSync(join(src, '.credentials.json'))).toBe(true)
  })

  test('an imported account adopts a newer login of its source dir without writing there', () => {
    const src = mkdtempSync(join(tmpdir(), 'fnh-src-'))
    writeFileSync(join(src, '.credentials.json'), JSON.stringify(oauth('old')))
    importAnthropicAccount(src, 'claude-b', env())
    writeFileSync(join(src, '.credentials.json'), JSON.stringify(oauth('new', { expiresAt: far + 1000 })))
    resetSessionAccountsForTesting()
    expect(readAccountTokens('claude-b', env())?.accessToken).toBe('new')
    expect(isFresherToken({ accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: [] }, { accessToken: 'b', refreshToken: 'r', expiresAt: 2, scopes: [] })).toBe(false)
  })
})

describe('routing and scope', () => {
  const setup = () => {
    writeFileSync(
      join(dir, 'accounts.json'),
      JSON.stringify({ accounts: { 'claude-b': { kind: 'anthropic' }, qwen: { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', model: 'q' } } }),
    )
    writeAccountTokens('claude-b', oauth('token-b').claudeAiOauth)
    writeFileSync(join(dir, 'accounts', 'claude-b', 'oauth-account.json'), JSON.stringify({ accountUuid: 'ub', emailAddress: 'b@empresa.test' }))
  }

  test('claude-b:sonnet routes natively to claude-b with the alias resolved', () => {
    setup()
    const r = routeForModel('claude-b:sonnet', { env: { ...env(), FNHARNESS_ACCOUNT: 'qwen' }, claudeDefaults: { opus: 'o', sonnet: 's-1', haiku: 'h' }, originalSlots: {} })
    expect(r).toMatchObject({ accountId: 'claude-b', profile: null, model: 's-1', current: false })
  })

  test('inside the scope of claude-b, tokens and identity are those of claude-b, outside they are root', () => {
    setup()
    process.env.FNHARNESS_ACCOUNT = 'claude'
    expect(tokenAccountId()).toBeNull()
    const route = routeForModel('claude-b:haiku', { claudeDefaults: { opus: 'o', sonnet: 's', haiku: 'h' }, originalSlots: {} })!
    const inside = withModelRoute('claude-b:haiku', () => ({
      active: activeAnthropicAccountId(),
      tokenAccount: tokenAccountId(),
      token: readAccountTokens(tokenAccountId()!)?.accessToken,
      email: readAccountInfo(tokenAccountId()!)?.emailAddress,
    }), route)
    expect(inside).toEqual({ active: 'claude-b', tokenAccount: 'claude-b', token: 'token-b', email: 'b@empresa.test' })
    expect(activeAnthropicAccountId()).toBe('claude')
    expect(tokenAccountId()).toBeNull()
  })

  test('a forced env token keeps the root path', () => {
    setup()
    process.env.FNHARNESS_ACCOUNT = 'claude-b'
    expect(tokenAccountId()).toBe('claude-b')
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'x'
    expect(tokenAccountId()).toBeNull()
  })

  test('status reports a login without exposing the token', () => {
    setup()
    const s = anthropicAccountStatus('claude-b', {}, env())
    expect(s).toMatchObject({ hasToken: true, plan: 'team', email: 'b@empresa.test' })
    expect(JSON.stringify(s)).not.toContain('token-b')
  })
})

describe('permissions', () => {
  test('open modes are found and fixed', () => {
    mkdirSync(join(dir, 'accounts', 'x'), { recursive: true })
    writeFileSync(join(dir, 'accounts', 'x', 'credentials.json'), '{}')
    chmodSync(join(dir, 'accounts', 'x', 'credentials.json'), 0o644)
    chmodSync(join(dir, 'accounts', 'x'), 0o755)
    const bad = auditAccountPermissions(env()).filter(f => !f.ok)
    expect(bad.map(f => f.kind).sort()).toEqual(['dir', 'dir', 'file'])
    fixAccountPermissions(bad)
    expect(auditAccountPermissions(env()).every(f => f.ok)).toBe(true)
    expect(permissionFinding('/p', 'file', 0o100600).ok).toBe(true)
    expect(permissionFinding('/p', 'file', 0o100640).ok).toBe(false)
  })
})
