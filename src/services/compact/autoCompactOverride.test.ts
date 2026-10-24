import { describe, expect, test } from 'bun:test'
import {
  applyThresholdOverride,
  getAutoCompactOverride,
  parseAutoCompactArg,
  setAutoCompactOverride,
} from './autoCompactOverride.js'

describe('parseAutoCompactArg', () => {
  test('empty means status only', () => {
    expect(parseAutoCompactArg('')).toEqual({ ok: true, value: null })
    expect(parseAutoCompactArg(undefined)).toEqual({ ok: true, value: null })
  })
  test('auto and off', () => {
    expect(parseAutoCompactArg(' AUTO ')).toEqual({ ok: true, value: { kind: 'auto' } })
    expect(parseAutoCompactArg('off')).toEqual({ ok: true, value: { kind: 'off' } })
  })
  test('token counts with suffixes', () => {
    expect(parseAutoCompactArg('150000')).toEqual({ ok: true, value: { kind: 'tokens', tokens: 150000 } })
    expect(parseAutoCompactArg('150k')).toEqual({ ok: true, value: { kind: 'tokens', tokens: 150000 } })
    expect(parseAutoCompactArg('1m')).toEqual({ ok: true, value: { kind: 'tokens', tokens: 1000000 } })
    expect(parseAutoCompactArg('12.5k')).toEqual({ ok: true, value: { kind: 'tokens', tokens: 12500 } })
    expect(parseAutoCompactArg('0.5m')).toEqual({ ok: true, value: { kind: 'tokens', tokens: 500000 } })
  })
  test('rejects garbage and tiny values', () => {
    expect(parseAutoCompactArg('lots').ok).toBe(false)
    expect(parseAutoCompactArg('-5').ok).toBe(false)
    expect(parseAutoCompactArg('500').ok).toBe(false)
  })
})

describe('applyThresholdOverride', () => {
  test('lowers but never raises the default', () => {
    expect(applyThresholdOverride(180000, { kind: 'tokens', tokens: 100000 })).toBe(100000)
    expect(applyThresholdOverride(180000, { kind: 'tokens', tokens: 900000 })).toBe(180000)
    expect(applyThresholdOverride(180000, null)).toBe(180000)
    expect(applyThresholdOverride(180000, { kind: 'off' })).toBe(180000)
  })
})

describe('override slot', () => {
  test('auto clears it', () => {
    setAutoCompactOverride({ kind: 'off' })
    expect(getAutoCompactOverride()).toEqual({ kind: 'off' })
    setAutoCompactOverride({ kind: 'auto' })
    expect(getAutoCompactOverride()).toBeNull()
  })
})
