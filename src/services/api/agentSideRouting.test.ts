/**
 * Side calls made from inside a subagent routed to another account
 * (`cuenta:modelo`) must be served by that account, never by the session's:
 * the small-fast model (WebFetch, prompt hooks...) and token counting.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  agentAccountRoute,
  agentSideModel,
  resetAccountRoutingForTesting,
  tryRouteForModel,
} from './accountRouting.js'
import {
  runWithAgentModel,
  withAgentModelGenerator,
  getAgentScopeModel,
} from '../../utils/model/agentModelScope.js'
import { getSessionSmallFastModel, getSmallFastModel } from '../../utils/model/model.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  localTokenCountEstimate,
  tokenCountPlan,
} from '../tokenEstimation.js'

const DEFAULTS = { opus: 'claude-opus-x', sonnet: 'claude-sonnet-x', haiku: 'claude-haiku-x' }
const store = {
  accounts: {
    acctz: { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'big-z', smallModel: 'small-z' },
    'claude-other': { kind: 'anthropic' },
  },
}
const deps = { env: {}, store, claudeDefaults: DEFAULTS, originalSlots: {}, currentAccount: 'claude' } as never

const saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch
let fetchCalls: string[] = []

beforeAll(() => {
  for (const k of ['CLAUDE_CONFIG_DIR', 'FNHARNESS_ACCOUNT', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_API_KEY']) saved[k] = process.env[k]
  const dir = mkdtempSync(join(tmpdir(), 'fnh-side-'))
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify(store))
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.FNHARNESS_ACCOUNT
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  // Auth checks along the way need some key; no request is ever made.
  process.env.ANTHROPIC_API_KEY = 'test-key'
  resetAccountRoutingForTesting()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input))
    throw new Error('no network in tests')
  }) as typeof fetch
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetAccountRoutingForTesting()
  globalThis.fetch = realFetch
})

describe('agent model scope', () => {
  test('a wrapped generator keeps the agent model across next() and in detached promises', async () => {
    let detached: Promise<string | undefined> | undefined
    async function* body() {
      yield getAgentScopeModel()
      await Promise.resolve()
      detached = new Promise(r => setTimeout(() => r(getAgentScopeModel()), 1))
      yield getAgentScopeModel()
    }
    const seen: (string | undefined)[] = []
    for await (const m of withAgentModelGenerator('acctz:big-z', body())) seen.push(m)
    expect(seen).toEqual(['acctz:big-z', 'acctz:big-z'])
    expect(await detached).toBe('acctz:big-z')
    expect(getAgentScopeModel()).toBeUndefined()
  })
})

describe('agentAccountRoute / agentSideModel (pure deps)', () => {
  test('no agent, unprefixed agent or agent on the session account: no route, session fallback', () => {
    expect(agentAccountRoute(undefined, deps)).toBeNull()
    expect(agentAccountRoute('claude-sonnet-x', deps)).toBeNull()
    expect(agentAccountRoute('claude:sonnet', deps)).toBeNull()
    expect(agentSideModel('small', () => 'session-haiku', { ...(deps as object), agentModel: undefined } as never)).toBe('session-haiku')
    expect(agentSideModel('small', () => 'session-haiku', { ...(deps as object), agentModel: 'claude:opus' } as never)).toBe('session-haiku')
  })

  test('OpenAI-compatible account: its smallModel for small, the agent model for main', () => {
    const d = { ...(deps as object), agentModel: 'acctz:big-z' } as never
    expect(agentSideModel('small', () => 'session-haiku', d)).toBe('acctz:small-z')
    expect(agentSideModel('main', () => 'session-sonnet', d)).toBe('acctz:big-z')
  })

  test('another Claude account: its own Haiku / Sonnet, with the prefix', () => {
    const d = { ...(deps as object), agentModel: 'claude-other:claude-opus-x' } as never
    expect(agentSideModel('small', () => 'session-haiku', d)).toBe('claude-other:claude-haiku-x')
    expect(agentSideModel('main', () => 'session-sonnet', d)).toBe('claude-other:claude-sonnet-x')
  })
})

describe('getSmallFastModel inside a routed agent', () => {
  test('outside an agent it is the session small model, unprefixed', () => {
    expect(getSmallFastModel()).toBe(getSessionSmallFastModel())
    expect(tryRouteForModel(getSmallFastModel())).toBeNull()
  })

  test('inside an agent on acctz it is acctz:small-z, routed to acctz (WebFetch, hooks, queryHaiku)', () => {
    runWithAgentModel('acctz:big-z', () => {
      expect(getSmallFastModel()).toBe('acctz:small-z')
      expect(tryRouteForModel(getSmallFastModel())?.accountId).toBe('acctz')
      // Raw-client callers (quota check, API key check) keep the session's.
      expect(getSessionSmallFastModel()).not.toContain(':')
    })
  })

  test('inside an agent on another Claude account it is that account Haiku', () => {
    runWithAgentModel('claude-other:claude-opus-x', () => {
      const m = getSmallFastModel()
      expect(m.startsWith('claude-other:')).toBe(true)
      expect(m).toContain('haiku')
    })
  })
})

describe('token counting inside a routed agent', () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(400) }]

  test('tokenCountPlan: local for an OpenAI-compatible agent, that account for a Claude one, session otherwise', () => {
    expect(tokenCountPlan(() => 'sess-model', { ...(deps as object), agentModel: 'acctz:big-z' } as never)).toEqual({ kind: 'local' })
    const other = tokenCountPlan(() => 'sess-model', { ...(deps as object), agentModel: 'claude-other:claude-opus-x' } as never)
    expect(other.kind === 'api' && other.model === 'claude-opus-x' && other.route?.accountId === 'claude-other').toBe(true)
    expect(tokenCountPlan(() => 'sess-model', { ...(deps as object), agentModel: undefined } as never)).toEqual({ kind: 'api', model: 'sess-model', route: null })
  })

  test('countMessagesTokensWithAPI and the Haiku fallback never call any API for an OpenAI-compatible agent', async () => {
    fetchCalls = []
    const expected = localTokenCountEstimate(messages, [])
    await runWithAgentModel('acctz:big-z', async () => {
      expect(await countMessagesTokensWithAPI(messages, [])).toBe(expected)
      expect(await countTokensViaHaikuFallback(messages, [])).toBe(expected)
    })
    expect(fetchCalls).toEqual([])
    expect(expected).toBeGreaterThan(100)
  })
})
