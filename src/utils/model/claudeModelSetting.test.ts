import { describe, expect, test } from 'bun:test'
import { isClaudeModelSetting } from './model.js'

describe('isClaudeModelSetting', () => {
  test('aliases and Claude ids count, other accounts\' models do not', () => {
    for (const m of ['opus', 'sonnet[1m]', 'opusplan', 'claude-opus-5-5', 'claude-sonnet-4-6[1m]', 'us.anthropic.claude-opus-4-8-v1:0']) {
      expect(isClaudeModelSetting(m)).toBe(true)
    }
    for (const m of ['qwen3:1.7b', 'qwen36-35b-heretic-q4km', 'deepseek-v4-1-flash-uncensored']) {
      expect(isClaudeModelSetting(m)).toBe(false)
    }
  })
})
