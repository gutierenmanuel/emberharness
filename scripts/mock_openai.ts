// Scripted OpenAI-compatible chat server for end-to-end tests of the loop and
// Monitor machinery without a real model.
//
//   bun run scripts/mock_openai.ts [port]      (default 8799)
//
// Rules are keyed on the last message of each request:
//   user text containing "# /loop: fixed schedule"  -> CronCreate with the cron from the text
//   user text containing "# /loop: self-paced"      -> ScheduleWakeup(60s, "/loop check mock")
//   user text containing "MONITOR_DEMO"              -> Monitor(a command printing 3 lines)
//   user text containing "MONITOR_STOP_DEMO"        -> Monitor(endless ticker), then TaskStop on its id
//   user text containing "<event>"                   -> plain text acknowledging the event
//   user text containing "AGENT_DEMO"                -> two Agent calls (run_in_background) whose sub-agents answer after MOCK_SUB_DELAY_MS (12 s)
//   user text containing "AGENT_PAR"                 -> two Explore agents in a single response (grouped launch message)
//   user text containing "PREGUNTA"                  -> AskUserQuestion (header Tienda, options Mercadona / Dia); its tool result is echoed as "MOCK recibio: ..."
//   user text containing "ECO:"                      -> plain text "MOCK eco: <text after ECO:>"
//   any tool result                                  -> plain text "ok"
// Every request body is appended to $MOCK_LOG (default /tmp/mock_openai.log) as one JSON line.

import { appendFileSync } from 'fs'

const port = Number(process.argv[2] ?? 8799)
const logPath = process.env.MOCK_LOG ?? '/tmp/mock_openai.log'

type Msg = { role: string; content?: unknown }

function textOf(m: Msg | undefined): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((p: { text?: string }) => p.text ?? '').join('\n')
  }
  return ''
}

type Plan = { text?: string; tool?: { name: string; args: unknown }; tools?: { name: string; args: unknown }[] }

function plan(messages: Msg[]): Plan {
  const last = messages[messages.length - 1]
  const t = textOf(last)
  // A sub-agent started by AGENT_DEMO: sleep (so the panel stays visible), then answer.
  const userText = messages.filter(m => m.role === 'user').map(textOf).join('\n')
  if (userText.includes('AGENT_SUB') && !userText.includes('AGENT_DEMO')) {
    // The delay in fetch() keeps the sub-agent alive long enough to see it in the panel.
    return { text: 'sub-agent done' }
  }
  if (last?.role === 'tool' && userText.includes('PREGUNTA') && !userText.includes('AGENT_DEMO')) {
    return { text: `MOCK recibio: ${t}` }
  }
  if (last?.role === 'user' && t.includes('PREGUNTA')) {
    return {
      tool: {
        name: 'AskUserQuestion',
        args: {
          questions: [{
            question: '¿Dónde compro?',
            header: 'Tienda',
            multiSelect: false,
            options: [
              { label: 'Mercadona', description: 'cerca' },
              { label: 'Dia', description: 'barato' },
            ],
          }],
        },
      },
    }
  }
  // AGENT_PAR: two Explore agents in ONE response (one message id), so the UI groups them.
  if (last?.role === 'user' && t.includes('AGENT_PAR')) {
    const agent = (description: string) => ({
      name: 'Agent',
      args: { description, prompt: 'AGENT_SUB count files', subagent_type: 'Explore', run_in_background: true },
    })
    return { tools: [agent('count src'), agent('count utils')] }
  }
  const eco = last?.role === 'user' ? /ECO:\s*(.*)/s.exec(t) : null
  if (eco) return { text: `MOCK eco: ${eco[1]!.trim()}` }
  if (last?.role === 'tool' && !userText.includes('AGENT_DEMO')) {
    // Monitor started in the STOP demo: stop it right away with TaskStop.
    const started = /Monitor started \(task (\w+)/.exec(t)
    const stopDemo = messages.some(m => textOf(m).includes('MONITOR_STOP_DEMO'))
    if (started && stopDemo) return { tool: { name: 'TaskStop', args: { task_id: started[1] } } }
    return { text: 'ok' }
  }
  if (t.includes('AGENT_DEMO') || messages.some(m => m.role === 'user' && textOf(m).includes('AGENT_DEMO'))) {
    const launched = messages.filter(m => m.role === 'tool').length
    if (launched < 2) {
      return {
        tool: {
          name: 'Agent',
          args: {
            description: launched === 0 ? 'count src' : 'count utils',
            prompt: 'AGENT_SUB count files',
            subagent_type: 'general-purpose',
            run_in_background: true,
          },
        },
      }
    }
  }
  if (t.includes('MONITOR_STOP_DEMO')) {
    return {
      tool: {
        name: 'Monitor',
        args: { command: 'while true; do echo STOPDEMO_TICK; sleep 1; done', description: 'stoppable monitor', persistent: true },
      },
    }
  }
  if (t.includes('# /loop: fixed schedule')) {
    const cron = /`cron`: `([^`]+)`/.exec(t)?.[1] ?? '*/1 * * * *'
    return { tool: { name: 'CronCreate', args: { cron, recurring: true, prompt: 'echo tick from cron' } } }
  }
  if (t.includes('# /loop: self-paced')) {
    return {
      tool: {
        name: 'ScheduleWakeup',
        args: { delaySeconds: 60, prompt: '/loop check mock', reason: 'mock wants to look again' },
      },
    }
  }
  if (t.includes('MONITOR_DEMO')) {
    return {
      tool: {
        name: 'Monitor',
        args: {
          command: 'for i in 1 2 3; do echo "line $i"; sleep 1; done; echo ERROR final',
          description: 'demo monitor',
          timeout_ms: 60000,
        },
      },
    }
  }
  if (t.includes('<event>')) return { text: 'MOCK saw the monitor event' }
  return { text: 'MOCK reply' }
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return Response.json({ data: [{ id: 'mock-model' }] })
    }
    if (!url.pathname.endsWith('/chat/completions')) return new Response('nope', { status: 404 })
    const body = (await req.json()) as { messages: Msg[]; tools?: { function: { name: string } }[]; stream?: boolean }
    appendFileSync(
      logPath,
      JSON.stringify({ at: new Date().toISOString(), tools: body.tools?.map(t => t.function.name), last: textOf(body.messages.at(-1)).slice(0, 400), role: body.messages.at(-1)?.role, nMessages: body.messages.length, events: body.messages.map(textOf).join('\n').split('<event>').length - 1 }) + '\n',
    )
    const p = plan(body.messages)
    const joined = body.messages.filter(m => m.role === 'user').map(textOf).join('\n')
    if (joined.includes('AGENT_SUB') && !joined.includes('AGENT_DEMO')) await Bun.sleep(Number(process.env.MOCK_SUB_DELAY_MS ?? 12000))
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock-model' }
    if (body.stream === false) {
      return Response.json({
        ...base,
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: p.tool ? 'tool_calls' : 'stop',
          message: p.tool
            ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }
            : { role: 'assistant', content: p.text },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    }
    const chunks: string[] = []
    chunks.push(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
    if (p.tools) {
      p.tools.forEach((tl, i) =>
        chunks.push(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: 'function', function: { name: tl.name, arguments: JSON.stringify(tl.args) } }] }, finish_reason: null }] })),
      )
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    } else if (p.tool) {
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }, finish_reason: null }] }))
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    } else {
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: { content: p.text }, finish_reason: null }] }))
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    }
    chunks.push('data: [DONE]\n\n')
    return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } })
  },
})
console.error(`mock openai on :${port}`)
