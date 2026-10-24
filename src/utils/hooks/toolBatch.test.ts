import { describe, expect, test } from 'bun:test'
import { buildToolBatchCalls } from './toolBatch.js'

describe('buildToolBatchCalls', () => {
  test('pairs each tool_use with its tool_result content', () => {
    const calls = buildToolBatchCalls(
      [
        { id: 'a', name: 'Read', input: { file_path: '/x' } },
        { id: 'b', name: 'Bash', input: { command: 'ls' } },
      ],
      [
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'out' }] } },
        { type: 'attachment' },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'hi' }] }] } },
      ],
    )
    expect(calls).toEqual([
      { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'a', tool_response: [{ type: 'text', text: 'hi' }] },
      { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b', tool_response: 'out' },
    ])
  })

  test('a missing result becomes an empty string', () => {
    expect(buildToolBatchCalls([{ id: 'z', name: 'T', input: {} }], [])[0]!.tool_response).toBe('')
  })
})
