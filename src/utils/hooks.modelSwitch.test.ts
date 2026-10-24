import { describe, expect, test } from 'bun:test'
import { canonicalModelForMatcher, decideModelSwitch } from './hooks.js'

const r = (o: Partial<Parameters<typeof decideModelSwitch>[0][number]>) => ({
  command: 'x',
  succeeded: true,
  output: '',
  blocked: false,
  ...o,
})

describe('decideModelSwitch', () => {
  test('no results or plain successes allow', () => {
    expect(decideModelSwitch([]).decision).toBe('allow')
    expect(decideModelSwitch([r({})]).decision).toBe('allow')
  })
  test('exit 2 (blocked) denies with the stderr reason', () => {
    const d = decideModelSwitch([r({ blocked: true, succeeded: false, output: 'retired', reason: 'retired' })])
    expect(d).toMatchObject({ decision: 'deny', reason: 'retired' })
  })
  test('deny > ask > allow', () => {
    expect(decideModelSwitch([r({ permissionDecision: 'allow' }), r({ permissionDecision: 'ask', reason: 'sure?' })])).toMatchObject({ decision: 'ask', reason: 'sure?' })
    expect(decideModelSwitch([r({ permissionDecision: 'ask' }), r({ permissionDecision: 'deny', reason: 'no' })])).toMatchObject({ decision: 'deny', reason: 'no' })
  })
  test('a hook cancelled by its timeout blocks', () => {
    expect(decideModelSwitch([r({ succeeded: false, output: 'Hook cancelled' })]).decision).toBe('deny')
  })
  test('system messages are collected whatever the decision', () => {
    expect(decideModelSwitch([r({ systemMessage: 'cost ~$1' })]).systemMessages).toEqual(['cost ~$1'])
  })
})

describe('canonicalModelForMatcher', () => {
  test('strips [1m] and canonicalises Claude ids; other ids are lowercased', () => {
    expect(canonicalModelForMatcher('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
    expect(canonicalModelForMatcher('Qwen36-35B')).toBe('qwen36-35b')
  })
})
