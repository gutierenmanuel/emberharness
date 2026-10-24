import { afterEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import {
  accountPredicate,
  applyFallback,
  configureFallbackChain,
  isFallbackActive,
  isFallbackEligible,
  parseFallbackList,
  parseFallbackTarget,
  peekNextFallback,
  resetFallbackChainForTesting,
  restorePrimary,
} from './fallbackChain.js'
import { resetActiveProfileForTesting, setActiveProfile, resolveProfile } from './openai-compat/profiles.js'

const store = { accounts: { mine: { provider: 'custom', baseUrl: 'http://x/v1', model: 'm1' } } }
const isAccount = accountPredicate(store)

describe('parseFallbackList', () => {
  test('accepts string, comma list and array; dedupes and caps at 3', () => {
    expect(parseFallbackList('a, b,,a')).toEqual(['a', 'b'])
    expect(parseFallbackList(['a', 'b,c', 'd'])).toEqual(['a', 'b', 'c'])
    expect(parseFallbackList(undefined)).toEqual([])
  })
})

describe('parseFallbackTarget', () => {
  test('account only, account:model, model only', () => {
    expect(parseFallbackTarget('qwen36', isAccount)).toEqual({ raw: 'qwen36', account: 'qwen36' })
    expect(parseFallbackTarget('claude:haiku', isAccount)).toEqual({ raw: 'claude:haiku', account: 'claude', model: 'haiku' })
    expect(parseFallbackTarget('openrouter:x/y', isAccount)).toMatchObject({ account: 'openrouter', model: 'x/y' })
    expect(parseFallbackTarget('mine', isAccount).account).toBe('mine')
    expect(parseFallbackTarget('gpt-4.1-mini', isAccount)).toEqual({ raw: 'gpt-4.1-mini', model: 'gpt-4.1-mini' })
  })
  test('a model id with a colon is not mistaken for an account', () => {
    expect(parseFallbackTarget('qwen3:8b', isAccount)).toEqual({ raw: 'qwen3:8b', model: 'qwen3:8b' })
  })
})

describe('isFallbackEligible', () => {
  const err = (status: number) => new APIError(status, undefined, 'x', undefined)
  test('only unavailability (5xx/529) falls back', () => {
    expect(isFallbackEligible(err(503))).toBe(true)
    expect(isFallbackEligible(err(529))).toBe(true)
    expect(isFallbackEligible(err(500))).toBe(true)
    for (const s of [400, 401, 403, 404, 429]) expect(isFallbackEligible(err(s))).toBe(false)
    expect(isFallbackEligible(new Error('boom'))).toBe(false)
  })
})

describe('chain walk', () => {
  afterEach(() => {
    resetFallbackChainForTesting()
    resetActiveProfileForTesting()
  })

  test('moves down the chain, then restores the primary', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: '/nonexistent-fnharness-test',
      OPENAI_API_KEY: 'k',
    }
    setActiveProfile(resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'qwen36' }), 'qwen36', env)
    configureFallbackChain(['qwen36', 'openai:gpt-x', 'claude:haiku'], env, { accounts: {} })

    // Entry 0 is the account already active: skipped.
    const first = peekNextFallback('qwen36-35b-heretic-q4km', { accounts: {} })!
    expect(first.accountId).toBe('openai')
    expect(first.model).toBe('gpt-x')
    expect(applyFallback(first, () => 'unused')).toBe('gpt-x')
    expect(env.FNHARNESS_ACCOUNT).toBe('openai')
    expect(env.ANTHROPIC_MODEL).toBe('gpt-x')
    expect(isFallbackActive()).toBe(true)

    const second = peekNextFallback('gpt-x', { accounts: {} })!
    expect(second.accountId).toBe('claude')
    expect(applyFallback(second, a => `resolved-${a}`)).toBe('resolved-haiku')
    expect(env.FNHARNESS_ACCOUNT).toBe('claude')
    expect(peekNextFallback('resolved-haiku', { accounts: {} })).toBeNull()

    expect(restorePrimary()?.accountId).toBe('qwen36')
    expect(env.FNHARNESS_ACCOUNT).toBe('qwen36')
    expect(isFallbackActive()).toBe(false)
    expect(restorePrimary()).toBeNull()
  })

  test('entries that cannot be resolved (missing key) are skipped', () => {
    const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: '/nonexistent-fnharness-test' }
    setActiveProfile(resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'qwen36' }), 'qwen36', env)
    configureFallbackChain(['openai', 'llamacpp'], env, { accounts: {} })
    expect(peekNextFallback('x', { accounts: {} })?.accountId).toBe('llamacpp')
  })
})
