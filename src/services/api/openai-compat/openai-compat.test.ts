import { describe, expect, test } from 'bun:test'
import { createOpenAICompatFetch } from './adapter.js'
import { resolveProfile } from './profiles.js'
import { collectMessage, toAnthropicEvents } from './stream.js'
import { translateMessages, translateRequest } from './translate.js'

describe('resolveProfile', () => {
  test('returns null when no provider is set', () => {
    expect(resolveProfile({})).toBeNull()
  })

  test('uses the preset and strips the trailing slash from overrides', () => {
    const p = resolveProfile({
      CLAUDE_MULTIMODEL_PROVIDER: 'ollama',
      CLAUDE_MULTIMODEL_BASE_URL: 'http://box:11434/v1/',
      CLAUDE_MULTIMODEL_MODEL: 'qwen3:1.7b',
    })
    expect(p?.baseUrl).toBe('http://box:11434/v1')
    expect(p?.model).toBe('qwen3:1.7b')
    expect(p?.smallModel).toBe('qwen3:1.7b')
  })

  test('rejects unknown providers and missing keys', () => {
    expect(() => resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'nope' })).toThrow()
    expect(() => resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/,
    )
    expect(
      resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })
        ?.apiKey,
    ).toBe('k')
  })
})

describe('translateMessages', () => {
  test('maps tool_use / tool_result and keeps results before user text', () => {
    const out = translateMessages('sys', [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'hmm' },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'thanks' },
          { type: 'tool_result', tool_use_id: 't1', content: 'a.txt' },
        ],
      },
    ])
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect((out[2] as any).tool_calls[0].function.arguments).toBe('{"command":"ls"}')
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'a.txt' })
  })
})

describe('translateRequest', () => {
  test('maps claude-* models to the profile model and uses the token param', () => {
    const req = translateRequest(
      { model: 'claude-sonnet-4-6', messages: [], max_tokens: 100, tool_choice: { type: 'any' }, tools: [{ name: 'x' }] },
      { model: 'gpt-4.1', maxTokensParam: 'max_completion_tokens' },
    )
    expect(req.model).toBe('gpt-4.1')
    expect(req.max_completion_tokens).toBe(100)
    expect(req.tool_choice).toBe('required')
  })
})

async function* chunks(...cs: object[]) {
  for (const c of cs) yield c as any
}

describe('toAnthropicEvents', () => {
  test('streams text then emits whole tool calls with tool_use stop reason', async () => {
    const events = []
    for await (const e of toAnthropicEvents(
      chunks(
        { choices: [{ delta: { reasoning_content: 'think' } }] },
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ),
      'm',
      'msg1',
    )) events.push(e)

    const types = events.map(e => e.type)
    expect(types[0]).toBe('message_start')
    expect(types.at(-1)).toBe('message_stop')
    const msg = await collectMessage(chunksToEvents(events))
    expect(msg.content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(msg.content[2].input).toEqual({ a: 1 })
    expect(msg.stop_reason).toBe('tool_use')
    expect(msg.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 })
  })
})

async function* chunksToEvents(evs: any[]) {
  for (const e of evs) yield e
}

describe('createOpenAICompatFetch (against a fake backend)', () => {
  test('serves a streaming Messages call end to end', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        expect(new URL(req.url).pathname).toBe('/v1/chat/completions')
        const sse = [
          { choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
        ]
          .map(c => `data: ${JSON.stringify(c)}\n\n`)
          .join('') + 'data: [DONE]\n\n'
        return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    try {
      const f = createOpenAICompatFetch({
        provider: 'custom', label: 'fake', baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: undefined, model: 'm', smallModel: 'm', maxTokensParam: 'max_tokens',
      })
      const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'ping' }] }),
      })
      const text = await res.text()
      expect(text).toContain('event: content_block_delta')
      expect(text).toContain('"text":"pong"')
      expect(text).toContain('event: message_stop')

      const nonStream = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'ping' }] }),
      })
      expect((await nonStream.json()).content[0].text).toBe('pong')
    } finally {
      server.stop(true)
    }
  })
})
