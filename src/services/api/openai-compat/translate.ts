/**
 * Pure translation between the Anthropic Messages API and OpenAI Chat
 * Completions. No I/O here so it stays trivially testable.
 */

type Block = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | Block[]
  source?: { type?: string; media_type?: string; data?: string; url?: string }
  is_error?: boolean
}

type AnthropicMessage = { role: string; content: string | Block[] }

type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export type AnthropicRequest = {
  model?: string
  system?: string | Block[]
  messages?: AnthropicMessage[]
  tools?: AnthropicTool[]
  tool_choice?: { type: string; name?: string }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
}

export type ChatMessage = Record<string, unknown>

/** Plain text of a content value, flattening nested text blocks. */
function textOf(content: string | Block[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b.type === 'text' ? (b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

function imageUrlOf(block: Block): string | null {
  const src = block.source
  if (!src) return null
  if (src.type === 'base64' && src.data) {
    return `data:${src.media_type ?? 'image/png'};base64,${src.data}`
  }
  if (src.type === 'url' && src.url) return src.url
  return null
}

function toolResultText(block: Block): string {
  const body = textOf(block.content)
  const hasImage =
    Array.isArray(block.content) && block.content.some(b => b.type === 'image')
  const text = hasImage ? `${body}\n[image omitted]`.trim() : body
  return block.is_error ? `Error: ${text}` : text
}

function translateUser(content: string | Block[]): ChatMessage[] {
  if (typeof content === 'string') return [{ role: 'user', content }]

  // Tool results become standalone `tool` messages and must directly follow the
  // assistant tool_calls, so they are emitted before any trailing user text.
  const out: ChatMessage[] = []
  const parts: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      out.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: toolResultText(block),
      })
    } else if (block.type === 'text' && block.text) {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const url = imageUrlOf(block)
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  if (parts.length > 0) {
    const onlyText = parts.every(p => p.type === 'text')
    out.push({
      role: 'user',
      content: onlyText ? parts.map(p => p.text).join('\n') : parts,
    })
  }
  return out
}

function translateAssistant(content: string | Block[]): ChatMessage[] {
  if (typeof content === 'string') return [{ role: 'assistant', content }]

  const text = content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text)
    .join('\n')
  const toolCalls = content
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }))
  // Thinking blocks are dropped: other backends can't verify Anthropic signatures.
  if (!text && toolCalls.length === 0) return []
  return [
    {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

export function translateMessages(
  system: AnthropicRequest['system'],
  messages: AnthropicMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  const systemText = textOf(system)
  if (systemText) out.push({ role: 'system', content: systemText })
  for (const msg of messages) {
    out.push(
      ...(msg.role === 'assistant'
        ? translateAssistant(msg.content)
        : translateUser(msg.content)),
    )
  }
  return out
}

export function translateTools(tools: AnthropicTool[]) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

function translateToolChoice(choice: AnthropicRequest['tool_choice']) {
  if (!choice) return undefined
  if (choice.type === 'any') return 'required'
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } }
  }
  if (choice.type === 'none') return 'none'
  return 'auto'
}

/** Anthropic internal defaults (claude-*) map to the profile model. */
export function resolveModel(
  requested: string | undefined,
  profileModel: string,
): string {
  if (!requested || /^claude/i.test(requested)) return profileModel
  return requested.replace(/\[\d+[km]\]$/i, '')
}

export function translateRequest(
  body: AnthropicRequest,
  opts: { model: string; maxTokensParam: 'max_tokens' | 'max_completion_tokens' },
): Record<string, unknown> {
  const chat: Record<string, unknown> = {
    model: resolveModel(body.model, opts.model),
    messages: translateMessages(body.system, body.messages ?? []),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (body.max_tokens) chat[opts.maxTokensParam] = body.max_tokens
  if (body.temperature !== undefined) chat.temperature = body.temperature
  if (body.top_p !== undefined) chat.top_p = body.top_p
  if (body.stop_sequences?.length) chat.stop = body.stop_sequences
  if (body.tools?.length) {
    chat.tools = translateTools(body.tools)
    const choice = translateToolChoice(body.tool_choice)
    if (choice) chat.tool_choice = choice
  }
  return chat
}
