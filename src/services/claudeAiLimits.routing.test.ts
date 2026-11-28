/**
 * The session's 5h/7d limits come only from responses of the session's own
 * account. A subagent routed to another account (OpenAI-compatible, or another
 * Claude account such as claude-aurgi) must not clear or overwrite them.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { runInProfileScope } from './api/openai-compat/profiles.js'
import {
  currentLimits,
  emitStatusChange,
  extractQuotaStatusFromHeaders,
  getRawUtilization,
  resetAccountUtilizationForTesting,
  updatesSessionLimits,
} from './claudeAiLimits.js'

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ['FNHARNESS_ACCOUNT', 'ANTHROPIC_API_KEY']) saved[k] = process.env[k]
  delete process.env.FNHARNESS_ACCOUNT
  // Auth checks along the quota path need some key; no request is ever made.
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetAccountUtilizationForTesting()
})

describe('5h/7d limits are not overwritten by another account', () => {
  const headers = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.9',
    'anthropic-ratelimit-unified-5h-reset': '100',
  })
  const zScope = () => ({ accountId: 'acctz', profile: null, live: true })

  test('updatesSessionLimits only for the session account', () => {
    expect(updatesSessionLimits('claude', 'claude')).toBe(true)
    expect(updatesSessionLimits('acctz', 'claude')).toBe(false)
    expect(updatesSessionLimits('claude-aurgi', 'claude')).toBe(false)
  })

  test('a response served inside another account scope leaves currentLimits and the session windows alone', () => {
    resetAccountUtilizationForTesting()
    const sessionLimits = { status: 'rejected' as const, resetsAt: 12345, unifiedRateLimitFallbackAvailable: false, isUsingOverage: false }
    emitStatusChange(sessionLimits)
    runInProfileScope(zScope(), () => extractQuotaStatusFromHeaders(headers))
    runInProfileScope({ accountId: 'claude-other', profile: null, live: true }, () => extractQuotaStatusFromHeaders(headers))
    extractQuotaStatusFromHeaders(headers, 'claude-aurgi')
    expect(currentLimits).toEqual(sessionLimits)
    expect(getRawUtilization()).toEqual({})
  })
})
