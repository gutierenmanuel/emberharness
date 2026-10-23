import { describe, expect, test } from 'bun:test'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  scaledBuffer,
} from './autoCompact.js'

describe('scaledBuffer', () => {
  test('leaves the fixed buffers alone on 200k windows', () => {
    expect(scaledBuffer(AUTOCOMPACT_BUFFER_TOKENS, 180_000, 0.1)).toBe(13_000)
    expect(scaledBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, 167_000, 0.15)).toBe(20_000)
  })

  test('shrinks them on a 32k local window', () => {
    // 32768 window - 4096 reserved output = 28672 effective
    expect(scaledBuffer(AUTOCOMPACT_BUFFER_TOKENS, 28_672, 0.1)).toBe(2_867)
    const threshold = 28_672 - 2_867
    expect(threshold - scaledBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, threshold, 0.15)).toBeGreaterThan(0)
  })
})
