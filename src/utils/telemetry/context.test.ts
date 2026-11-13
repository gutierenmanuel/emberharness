import { describe, expect, test } from 'bun:test'
import { hostOf, isLocalHost, resolveTelemetryCtx, stripAccountPrefix } from './context.js'

const accounts: Record<string, { kind: 'anthropic' | 'openai_compat'; baseUrl?: string }> = {
  claude: { kind: 'anthropic' },
  'claude-work': { kind: 'anthropic' },
  qwen36: { kind: 'openai_compat', baseUrl: 'http://localhost:8090/v1' },
  venice: { kind: 'openai_compat', baseUrl: 'https://api.venice.ai/api/v1' },
  lan: { kind: 'openai_compat', baseUrl: 'http://192.168.1.20:8080/v1' },
}
const base = {
  kindOf: (id: string) => accounts[id]?.kind ?? 'openai_compat',
  baseUrlOf: (id: string) => accounts[id]?.baseUrl,
}
const known = Object.keys(accounts)

describe('resolveTelemetryCtx', () => {
  test('no scope: the session account, not routed', () => {
    const c = resolveTelemetryCtx({ ...base, sessionAccount: 'qwen36', model: 'qwen36-35b' }, known)
    expect(c).toMatchObject({ account: 'qwen36', accountKind: 'local', backend: 'localhost:8090', routed: false, sessionAccount: 'qwen36', model: 'qwen36-35b' })
  })
  test('OpenAI-compatible scope', () => {
    const c = resolveTelemetryCtx({ ...base, scopedAccount: 'venice', sessionAccount: 'claude' }, known)
    expect(c).toMatchObject({ account: 'venice', accountKind: 'openai_compat', backend: 'api.venice.ai', routed: true, sessionAccount: 'claude' })
  })
  test('Anthropic account B scoped from session A', () => {
    const c = resolveTelemetryCtx({ ...base, scopedAccount: 'claude-work', sessionAccount: 'claude', model: 'claude-work:sonnet', agentType: 'general-purpose' }, known)
    expect(c).toMatchObject({ account: 'claude-work', accountKind: 'anthropic', backend: 'api.anthropic.com', routed: true, sessionAccount: 'claude', model: 'sonnet', agentType: 'general-purpose' })
  })
  test('LAN server counts as local, a public host does not', () => {
    expect(resolveTelemetryCtx({ ...base, sessionAccount: 'lan' }, known).accountKind).toBe('local')
    expect(resolveTelemetryCtx({ ...base, sessionAccount: 'venice' }, known).accountKind).toBe('openai_compat')
  })
  test('scope equal to the session is not routed', () => {
    expect(resolveTelemetryCtx({ ...base, scopedAccount: 'claude', sessionAccount: 'claude' }, known).routed).toBe(false)
  })
})

describe('helpers', () => {
  test('isLocalHost', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.4', '192.168.0.9', '172.20.1.1', 'box.local', '::1']) expect(isLocalHost(h)).toBe(true)
    for (const h of ['api.venice.ai', '172.32.0.1', '8.8.8.8', '']) expect(isLocalHost(h)).toBe(false)
  })
  test('stripAccountPrefix only strips known accounts', () => {
    expect(stripAccountPrefix('claude-work:haiku', known)).toBe('haiku')
    expect(stripAccountPrefix('qwen3:8b', known)).toBe('qwen3:8b')
    expect(stripAccountPrefix(undefined, known)).toBeUndefined()
  })
  test('hostOf', () => {
    expect(hostOf('http://localhost:8090/v1')).toBe('localhost:8090')
    expect(hostOf('nonsense')).toBeNull()
  })
})
