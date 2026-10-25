import { describe, expect, test } from 'bun:test'
import { HookCommandSchema } from '../../schemas/hooks.js'
import { HOOK_EVENTS } from '../../entrypoints/agentSdkTypes.js'
import {
  decideUserPromptExpansion,
  pickDisplayContent,
  type HookOutsideReplResult,
} from '../hooks.js'
import {
  mcpResultText,
  mcpToolHookTimeoutSeconds,
  substituteHookInput,
} from './execMcpToolHook.js'
import {
  ensureMessageDisplay,
  messageIdFor,
  resetMessageDisplayForTests,
} from './messageDisplay.js'

const r = (o: Partial<HookOutsideReplResult>): HookOutsideReplResult => ({
  command: 'x',
  succeeded: true,
  output: '',
  blocked: false,
  ...o,
})

describe('events', () => {
  test('UserPromptExpansion and MessageDisplay are registered', () => {
    expect(HOOK_EVENTS).toContain('UserPromptExpansion')
    expect(HOOK_EVENTS).toContain('MessageDisplay')
  })
})

describe('mcp_tool hook type', () => {
  test('schema accepts it', () => {
    const ok = HookCommandSchema().safeParse({
      type: 'mcp_tool',
      server: 'my_server',
      tool: 'security_scan',
      input: { file_path: '${tool_input.file_path}' },
    })
    expect(ok.success).toBe(true)
    expect(
      HookCommandSchema().safeParse({ type: 'mcp_tool', server: 's' }).success,
    ).toBe(false)
  })

  test('substitutes ${path} in nested strings, empty when unresolved', () => {
    const input = { tool_input: { file_path: '/a/b.ts', n: 3 }, cwd: '/w' }
    expect(
      substituteHookInput(
        { f: '${tool_input.file_path}', deep: ['x ${cwd}', { k: '${nope.x}' }], n: 7, o: '${tool_input}' },
        input,
      ),
    ).toEqual({
      f: '/a/b.ts',
      deep: ['x /w', { k: '' }],
      n: 7,
      o: '{"file_path":"/a/b.ts","n":3}',
    })
  })

  test('joins text blocks of the result', () => {
    expect(
      mcpResultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'zz' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb')
    expect(mcpResultText(undefined)).toBe('')
  })

  test('default timeouts follow the official docs', () => {
    const h = { type: 'mcp_tool', server: 's', tool: 't' } as const
    expect(mcpToolHookTimeoutSeconds(h, 'PostToolUse')).toBe(600)
    expect(mcpToolHookTimeoutSeconds(h, 'UserPromptSubmit')).toBe(30)
    expect(mcpToolHookTimeoutSeconds(h, 'PreModelSwitch')).toBe(30)
    expect(mcpToolHookTimeoutSeconds(h, 'MessageDisplay')).toBe(10)
    expect(mcpToolHookTimeoutSeconds({ ...h, timeout: 5 }, 'MessageDisplay')).toBe(5)
  })
})

describe('UserPromptExpansion decision', () => {
  test('block wins and carries the reason', () => {
    const d = decideUserPromptExpansion([
      r({ additionalContext: 'ctx' }),
      r({ blocked: true, reason: 'not available' }),
    ])
    expect(d.blocked).toBe(true)
    expect(d.reason).toBe('not available')
    expect(d.additionalContexts).toEqual([])
  })

  test('additionalContext and plain stdout become context, JSON stdout does not', () => {
    const d = decideUserPromptExpansion([
      r({ additionalContext: 'from json' }),
      r({ output: 'plain text' }),
      r({ output: '{"a":1}' }),
    ])
    expect(d.blocked).toBe(false)
    expect(d.additionalContexts).toEqual(['from json', 'plain text'])
  })
})

describe('MessageDisplay', () => {
  test('pickDisplayContent takes the last successful replacement', () => {
    expect(pickDisplayContent([])).toBeUndefined()
    expect(
      pickDisplayContent([
        r({ displayContent: 'a' }),
        r({ displayContent: 'b', succeeded: false }),
        r({ displayContent: 'c' }),
      ]),
    ).toBe('c')
    expect(pickDisplayContent([r({ displayContent: '' })])).toBe('')
  })

  test('message id is a stable UUID-shaped string', () => {
    expect(messageIdFor('hola')).toBe(messageIdFor('hola'))
    expect(messageIdFor('hola')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('ensureMessageDisplay runs the hook once per text', async () => {
    resetMessageDisplayForTests()
    let calls = 0
    const run = async (_t: string, _m: string, text: string) => {
      calls++
      return text.toUpperCase()
    }
    await Promise.all([
      ensureMessageDisplay('hello', run),
      ensureMessageDisplay('hello', run),
    ])
    await ensureMessageDisplay('hello', run)
    expect(calls).toBe(1)
  })
})
