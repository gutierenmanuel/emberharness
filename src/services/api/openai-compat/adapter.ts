/**
 * OpenAI-compatible fetch adapter
 *
 * Plugged into the Anthropic SDK as its `fetch`, it intercepts Messages API
 * calls and serves them from any OpenAI Chat Completions backend, so the whole
 * harness (tools, agents, MCP, hooks) runs unchanged on non-Anthropic models.
 */

import type { MultimodelProfile } from './profiles.js'
import {
  collectMessage,
  encodeSSE,
  parseSSE,
  toAnthropicEvents,
} from './stream.js'
import {
  buildSpeedSample,
  isLocalBaseUrl,
  localSpeedEnabled,
  recordSpeedSample,
} from './speedStats.js'
import { resolveModel, translateRequest, type AnthropicRequest } from './translate.js'

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

async function readBody(init?: RequestInit): Promise<AnthropicRequest> {
  try {
    const text =
      init?.body instanceof ReadableStream
        ? await new Response(init.body).text()
        : typeof init?.body === 'string'
          ? init.body
          : '{}'
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export function createOpenAICompatFetch(
  profile: MultimodelProfile,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const endpoint = `${profile.baseUrl}/chat/completions`

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) return globalThis.fetch(input, init)

    const body = await readBody(init)

    // Backends have no token-count endpoint; a ~4 chars/token estimate is what
    // the harness needs for context-window bookkeeping.
    if (url.includes('/count_tokens')) {
      const chars = JSON.stringify([body.system, body.messages, body.tools]).length
      return new Response(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const chatBody = translateRequest(body, {
      model: profile.model,
      maxTokensParam: profile.maxTokensParam,
    })
    const model = resolveModel(body.model, profile.model)

    const requestSentAt = Date.now()
    let upstream: Response
    try {
      upstream = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
        },
        body: JSON.stringify(chatBody),
        signal: init?.signal ?? undefined,
      })
    } catch (err) {
      return errorResponse(
        503,
        `${profile.label} unreachable at ${profile.baseUrl}: ${String(err)}`,
      )
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      return errorResponse(
        upstream.status || 502,
        `${profile.label} error (${upstream.status}): ${detail.slice(0, 2000)}`,
      )
    }

    const messageId = `msg_mm_${Date.now().toString(36)}`
    const trackSpeed = isLocalBaseUrl(profile.baseUrl) && localSpeedEnabled()
    const events = toAnthropicEvents(
      parseSSE(upstream.body),
      model,
      messageId,
      trackSpeed
        ? stats => {
            const sample = buildSpeedSample({ ...stats, withTools: !!chatBody.tools?.length })
            if (sample) recordSpeedSample(sample)
          }
        : undefined,
      requestSentAt,
    )

    if (!body.stream) {
      return new Response(JSON.stringify(await collectMessage(events)), {
        headers: { 'Content-Type': 'application/json', 'x-request-id': messageId },
      })
    }

    const encoder = new TextEncoder()
    let pull: AsyncIterator<Record<string, any>> | undefined
    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await (pull ??= events[Symbol.asyncIterator]()).next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(encodeSSE(value)))
      },
      cancel() {
        return pull?.return?.()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'x-request-id': messageId,
      },
    })
  }
}
