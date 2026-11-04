import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { sanitizeForeignHistoryForAnthropic } from './messages.js'

const assistant = (content: unknown[]): Message =>
  ({ type: 'assistant', uuid: 'a', message: { id: 'm', role: 'assistant', content } }) as unknown as Message
const user = (content: unknown[]): Message =>
  ({ type: 'user', uuid: 'u', message: { role: 'user', content } }) as unknown as Message

const blocks = (m: Message) => (m as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content

describe('sanitizeForeignHistoryForAnthropic', () => {
  test('drops unsigned thinking from another account and keeps signed Anthropic thinking', () => {
    const out = sanitizeForeignHistoryForAnthropic([
      assistant([{ type: 'thinking', thinking: 'glm', signature: '' }, { type: 'text', text: 'hola' }]),
      assistant([{ type: 'thinking', thinking: 'claude', signature: 'sig' }, { type: 'text', text: 'ok' }]),
      assistant([{ type: 'redacted_thinking', data: '' }]),
    ])
    expect(blocks(out[0]!).map(b => b.type)).toEqual(['text'])
    expect(blocks(out[1]!).map(b => b.type)).toEqual(['thinking', 'text'])
    expect(blocks(out[2]!)).toEqual([])
  })

  test('rewrites foreign tool ids on both tool_use and tool_result', () => {
    const out = sanitizeForeignHistoryForAnthropic([
      assistant([{ type: 'tool_use', id: 'functions.Read:0', name: 'Read', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 'functions.Read:0', content: 'x' }]),
    ])
    expect(blocks(out[0]!)[0]!.id).toBe('functions_Read_0')
    expect(blocks(out[1]!)[0]!.tool_use_id).toBe('functions_Read_0')
  })

  test('returns the same array when the history is already Anthropic-clean', () => {
    const msgs = [
      assistant([{ type: 'tool_use', id: 'toolu_01abc', name: 'Read', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 'toolu_01abc', content: 'x' }]),
    ]
    expect(sanitizeForeignHistoryForAnthropic(msgs)).toBe(msgs)
  })
})
