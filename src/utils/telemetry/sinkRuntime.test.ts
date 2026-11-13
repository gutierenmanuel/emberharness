import { afterEach, describe, expect, test } from 'bun:test'
import { resetActiveProfileForTesting, setActiveProfile, type MultimodelProfile } from '../../services/api/openai-compat/profiles.js'
import { getPrivacyLevel } from '../privacyLevel.js'
import { humanDisabledTelemetry, testPointJson } from './sinkRuntime.js'

const profile: MultimodelProfile = {
  provider: 'custom', label: 'x', baseUrl: 'http://127.0.0.1:1/v1', apiKey: undefined, model: 'm', smallModel: 'm', maxTokensParam: 'max_tokens',
}

afterEach(() => {
  resetActiveProfileForTesting()
  delete process.env.DISABLE_TELEMETRY
  delete process.env.FNHARNESS_PROFILE_NO_TELEMETRY
})

describe('DISABLE_TELEMETRY of the person versus the profile switch', () => {
  test('an OpenAI-compatible account sets FNHARNESS_PROFILE_NO_TELEMETRY and never DISABLE_TELEMETRY', () => {
    const env: Record<string, string | undefined> = {}
    setActiveProfile(profile, 'qwen36', env)
    expect(env.FNHARNESS_PROFILE_NO_TELEMETRY).toBe('1')
    expect(env.DISABLE_TELEMETRY).toBeUndefined()
    // Back to Claude: the profile switch goes away, the provider analytics rule with it.
    setActiveProfile(null, 'claude', env)
    expect(env.FNHARNESS_PROFILE_NO_TELEMETRY).toBeUndefined()
  })

  test('a DISABLE_TELEMETRY the person set is left alone by the profile', () => {
    const env: Record<string, string | undefined> = { DISABLE_TELEMETRY: '1' }
    setActiveProfile(profile, 'qwen36', env)
    expect(env.DISABLE_TELEMETRY).toBe('1')
  })

  test('only the person DISABLE_TELEMETRY switches off the receivers; the profile switch does not', () => {
    process.env.FNHARNESS_PROFILE_NO_TELEMETRY = '1'
    expect(humanDisabledTelemetry()).toBe(false)
    process.env.DISABLE_TELEMETRY = '1'
    expect(humanDisabledTelemetry()).toBe(true)
  })

  test("the provider's non-essential analytics stay off for either switch", () => {
    expect(getPrivacyLevel()).toBe('default')
    process.env.FNHARNESS_PROFILE_NO_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('no-telemetry')
    delete process.env.FNHARNESS_PROFILE_NO_TELEMETRY
    process.env.DISABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('no-telemetry')
  })
})

describe('test point', () => {
  test('is a valid delta OTLP/JSON counter with no identity or account', () => {
    const body = JSON.stringify(testPointJson('otel-3amdata'))
    const point = (testPointJson('otel-3amdata') as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string; sum: { aggregationTemporality: number } }> }> }> }).resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!
    expect(point.name).toBe('fnharness.telemetry.test')
    expect(point.sum.aggregationTemporality).toBe(1)
    expect(body).not.toContain('user.email')
    expect(body).not.toContain('organization.id')
  })
})
