/**
 * OpenAI Chat Completions SSE -> Anthropic streaming events.
 *
 * `toAnthropicEvents` is a pure async generator over parsed chunks, so the same
 * logic serves both streaming responses (encode as SSE) and non-streaming ones
 * (fold into a single message with `collectMessage`).
 */

export type AnthropicEvent = Record<string, any>

type ToolAcc = { id: string; name: string; args: string }

type Chunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  /** llama-server extension: prompt/predicted timings, cache_n, draft_n... */
  timings?: Record<string, unknown> | null
}

/** Raw facts about one finished request, for the local speed line. */
export type StreamStats = {
  timings: Record<string, unknown> | null
  usage: { prompt_tokens?: number; completion_tokens?: number } | null
  ttftMs: number | null
  totalMs: number
}

const STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
}

/** Parses an SSE byte stream into JSON chunks, ignoring comments and [DONE]. */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Chunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data) as Chunk
      } catch {
        // A malformed frame from a flaky local server shouldn't kill the turn.
      }
    }
  }
}

export async function* toAnthropicEvents(
  chunks: AsyncIterable<Chunk>,
  model: string,
  messageId: string,
  onStats?: (stats: StreamStats) => void,
  /** When the HTTP request was sent; defaults to now. TTFT counts from here. */
  startedAt: number = Date.now(),
): AsyncGenerator<AnthropicEvent> {
  let firstTokenAt: number | null = null
  let timings: Record<string, unknown> | null = null
  let usageSeen: StreamStats['usage'] = null
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  let index = -1
  let open: 'text' | 'thinking' | null = null
  const tools = new Map<number, ToolAcc>()
  let finish: string | null = null
  let inputTokens = 0
  let outputTokens = 0

  function* closeOpen(): Generator<AnthropicEvent> {
    if (open) {
      yield { type: 'content_block_stop', index }
      open = null
    }
  }

  function* openBlock(kind: 'text' | 'thinking'): Generator<AnthropicEvent> {
    if (open === kind) return
    yield* closeOpen()
    index++
    open = kind
    yield {
      type: 'content_block_start',
      index,
      content_block:
        kind === 'text'
          ? { type: 'text', text: '' }
          : { type: 'thinking', thinking: '', signature: '' },
    }
  }

  for await (const chunk of chunks) {
    if (chunk.timings) timings = chunk.timings
    if (chunk.usage) usageSeen = chunk.usage
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (
      firstTokenAt === null &&
      (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length)
    ) {
      firstTokenAt = Date.now()
    }

    const thinking = delta.reasoning_content ?? delta.reasoning
    if (thinking) {
      yield* openBlock('thinking')
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking },
      }
    }
    if (delta.content) {
      yield* openBlock('text')
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: delta.content },
      }
      // Rough count until the backend reports real usage in its final chunk.
      outputTokens += 1
    }
    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0
      const acc = tools.get(key) ?? { id: '', name: '', args: '' }
      if (call.id) acc.id = call.id
      if (call.function?.name) acc.name += call.function.name
      if (call.function?.arguments) acc.args += call.function.arguments
      tools.set(key, acc)
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }

  yield* closeOpen()

  const endedAt = Date.now()
  try {
    onStats?.({
      timings,
      usage: usageSeen,
      ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      totalMs: endedAt - startedAt,
    })
  } catch {
    // Metrics must never break a turn.
  }

  // Tool calls are emitted whole once the model is done. Backends interleave
  // and re-index them inconsistently, and the harness only acts on complete
  // calls anyway, so streaming the partial JSON buys nothing.
  for (const [key, acc] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
    index++
    yield {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: acc.id || `toolu_${messageId}_${key}`,
        name: acc.name,
        input: {},
      },
    }
    yield {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: acc.args || '{}' },
    }
    yield { type: 'content_block_stop', index }
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason:
        tools.size > 0 ? 'tool_use' : (STOP_REASONS[finish ?? 'stop'] ?? 'end_turn'),
      stop_sequence: null,
    },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
  yield { type: 'message_stop' }
}

export function encodeSSE(event: AnthropicEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** Folds an event stream into a single non-streaming Message object. */
export async function collectMessage(
  events: AsyncIterable<AnthropicEvent>,
): Promise<Record<string, any>> {
  let message: Record<string, any> = {}
  const partialJson = new Map<number, string>()
  for await (const ev of events) {
    if (ev.type === 'message_start') {
      message = { ...ev.message, content: [] }
    } else if (ev.type === 'content_block_start') {
      message.content[ev.index] = { ...ev.content_block }
    } else if (ev.type === 'content_block_delta') {
      const block = message.content[ev.index]
      const d = ev.delta
      if (d.type === 'text_delta') block.text += d.text
      else if (d.type === 'thinking_delta') block.thinking += d.thinking
      else if (d.type === 'input_json_delta') {
        partialJson.set(ev.index, (partialJson.get(ev.index) ?? '') + d.partial_json)
      }
    } else if (ev.type === 'message_delta') {
      message.stop_reason = ev.delta.stop_reason
      message.usage = { ...message.usage, ...ev.usage }
    }
  }
  for (const [i, json] of partialJson) {
    try {
      message.content[i].input = JSON.parse(json)
    } catch {
      message.content[i].input = {}
    }
  }
  return message
}
