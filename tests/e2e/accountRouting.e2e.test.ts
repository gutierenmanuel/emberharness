/**
 * Per-request account routing: the session runs on account A (one fake
 * OpenAI-compatible server), the model asks for an Agent with
 * `model: "acctb:model-b"`, and the subagent's request must reach server B with
 * the prefix stripped while every request of the main thread stays on A.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, hasCli, makeSandbox, stripAnsi } from './harness.js'

type Body = { model?: string; messages?: Array<{ role: string; content?: unknown }> }

const text = (m: { content?: unknown } | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? '').join('\n') : ''

function sse(model: string, delta: object, finish: string): string {
  const chunk = (d: object, f: string | null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`
  return (
    chunk({ role: 'assistant' }, null) +
    chunk(delta, null) +
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

/** A fake backend; `plan` decides the reply (text or one tool call). */
function fakeServer(model: string, plan: (b: Body) => { text?: string; tool?: { name: string; args: unknown }; delayMs?: number }) {
  const requests: Body[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as Body
      requests.push(body)
      const p = plan(body)
      if (p.delayMs) await Bun.sleep(p.delayMs)
      const out = p.tool
        ? sse(model, { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }, 'tool_calls')
        : sse(model, { content: p.text ?? '' }, 'stop')
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

const serverA = fakeServer('model-a', b => {
  const msgs = b.messages ?? []
  if (msgs.some(m => m.role === 'tool')) return { text: 'MAIN_DONE' }
  if (msgs.some(m => m.role === 'user' && text(m).includes('LANZA_SUB'))) {
    return { tool: { name: 'Agent', args: { description: 'sub en B', prompt: 'SUB_TASK di hola', subagent_type: 'general-purpose', model: 'acctb:model-b' } } }
  }
  return { text: 'ok' }
})
const serverB = fakeServer('model-b', () => ({ text: 'SUB_DONE_FROM_B' }))

afterAll(() => {
  serverA.stop()
  serverB.stop()
})

describe.skipIf(!hasCli)('account routing e2e', () => {
  test('Agent with model acctb:model-b is served by account B; the main thread stays on A', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({
        active: 'accta',
        accounts: {
          accta: { provider: 'custom', baseUrl: serverA.baseUrl, model: 'model-a' },
          acctb: { provider: 'custom', baseUrl: serverB.baseUrl, model: 'model-b' },
        },
      }),
    )
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, FNHARNESS_DISABLE_MODELS_FETCH: '1', FNHARNESS_CONTEXT_PROFILE: 'full' }
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k]
    for (const k of ['CLAUDE_MULTIMODEL_PROVIDER', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_BASE_URL', 'CLAUDE_MULTIMODEL_MODEL', 'FNHARNESS_ACCOUNT', 'ANTHROPIC_MODEL', 'TMUX']) delete env[k]
    // A default subagent model must not override an explicit cuenta:modelo.
    env.CLAUDE_CODE_SUBAGENT_MODEL = 'sonnet'
    const proc = Bun.spawn([CLI, '-p', 'LANZA_SUB ahora'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    await proc.exited
    if (!out.includes('MAIN_DONE')) console.error('stdout:', out.slice(0, 2000), '\nstderr:', err.slice(0, 2000))

    // The subagent reached B, with the account prefix removed.
    const subRequests = serverB.requests.filter(b => (b.messages ?? []).some(m => text(m).includes('SUB_TASK')))
    expect(subRequests.length).toBeGreaterThan(0)
    expect(subRequests.every(b => b.model === 'model-b')).toBe(true)
    // Nothing of the subagent went to A, and A only ever saw its own model.
    expect(serverA.requests.some(b => (b.messages ?? []).some(m => m.role === 'user' && text(m).includes('SUB_TASK') && !text(m).includes('LANZA_SUB')))).toBe(false)
    expect(serverA.requests.length).toBeGreaterThanOrEqual(2)
    expect(serverA.requests.every(b => b.model === 'model-a')).toBe(true)
    // The main thread got B's answer back as the tool result and finished on A.
    const last = serverA.requests.at(-1)!
    expect((last.messages ?? []).some(m => m.role === 'tool' && text(m).includes('SUB_DONE_FROM_B'))).toBe(true)
    expect(out).toContain('MAIN_DONE')

    // The subagent's sidecar names the Agent tool_use that launched it: the Matrix bridge
    // hangs each subagent thread on that id.
    const metas = [...new Bun.Glob('projects/*/*/subagents/agent-*.meta.json').scanSync({ cwd: configDir })]
    expect(metas.length).toBe(1)
    const meta = JSON.parse(readFileSync(join(configDir, metas[0]!), 'utf8')) as { agentType: string; toolUseId?: string; model?: string }
    expect(meta.agentType).toBe('general-purpose')
    // The routed model is persisted so a resume stays on account B.
    expect(meta.model).toBe('acctb:model-b')
    expect(meta.toolUseId).toMatch(/^call_/)
    const transcripts = [...new Bun.Glob('projects/*/*.jsonl').scanSync({ cwd: configDir })]
    expect(readFileSync(join(configDir, transcripts[0]!), 'utf8')).toContain(`"id":"${meta.toolUseId}"`)
  }, 100_000)
})

describe.skipIf(!hasCli)('resume keeps the account e2e', () => {
  test('SendMessage to a finished acctb agent resumes it on B, never on the session account A', async () => {
    const agentIdIn = (msgs: Body['messages']) => {
      for (const m of msgs ?? []) {
        const hit = /agentId: (a[0-9a-f]+)/.exec(text(m))
        if (m.role === 'tool' && hit) return hit[1]
      }
      return undefined
    }
    const a = fakeServer('model-a', b => {
      const msgs = b.messages ?? []
      if (!msgs.some(m => m.role === 'user' && text(m).includes('LANZA_RESUME'))) return { text: 'ok' }
      const tools = msgs.filter(m => m.role === 'tool')
      if (tools.length === 0) {
        return { tool: { name: 'Agent', args: { description: 'primera en B', prompt: 'SUB_R1 di uno', subagent_type: 'general-purpose', model: 'acctb:model-b' } } }
      }
      const id = agentIdIn(msgs)
      // Resume once the first run has finished (its completion notification arrived).
      const finished = msgs.some(m => m.role === 'user' && text(m).includes('<task-notification>'))
      // The delay lets the finished agent's transcript reach disk before the resume reads it.
      if (tools.length === 1 && id && finished) return { tool: { name: 'SendMessage', args: { to: id, message: 'SUB_R2 di dos', summary: 'sigue' } }, delayMs: 2000 }
      return { text: msgs.some(m => text(m).includes('B_DOS')) ? 'MAIN_DONE' : 'ESPERO' }
    })
    const b = fakeServer('model-b', body => ({ text: (body.messages ?? []).some(m => text(m).includes('SUB_R2')) ? 'B_DOS' : 'B_UNO' }))
    const { configDir, cwd } = makeSandbox()
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({
        active: 'accta',
        accounts: {
          accta: { provider: 'custom', baseUrl: a.baseUrl, model: 'model-a' },
          acctb: { provider: 'custom', baseUrl: b.baseUrl, model: 'model-b' },
        },
      }),
    )
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, FNHARNESS_DISABLE_MODELS_FETCH: '1', FNHARNESS_CONTEXT_PROFILE: 'full' }
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k]
    for (const k of ['CLAUDE_MULTIMODEL_PROVIDER', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_BASE_URL', 'CLAUDE_MULTIMODEL_MODEL', 'FNHARNESS_ACCOUNT', 'ANTHROPIC_MODEL', 'TMUX']) delete env[k]
    const proc = Bun.spawn([CLI, '-p', 'LANZA_RESUME ahora'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    await proc.exited
    a.stop()
    b.stop()
    const resumed = b.requests.filter(r => (r.messages ?? []).some(m => text(m).includes('SUB_R2')))
    if (resumed.length === 0) console.error('stdout:', out.slice(0, 2000), '\nstderr:', err.slice(0, 2000), '\nA:', JSON.stringify(a.requests.map(r => (r.messages ?? []).map(m => m.role + ':' + text(m).slice(0, 120)))).slice(0, 3000))
    // The resumed turn reached B with its prefix stripped, and carried the first turn.
    expect(resumed.length).toBeGreaterThan(0)
    expect(resumed.every(r => r.model === 'model-b')).toBe(true)
    expect(resumed[0]!.messages!.some(m => text(m).includes('SUB_R1'))).toBe(true)
    // A never served the subagent's turns.
    expect(a.requests.some(r => (r.messages ?? []).some(m => m.role === 'user' && text(m).startsWith('SUB_R2')))).toBe(false)
    expect(a.requests.every(r => r.model === 'model-a')).toBe(true)
  }, 100_000)
})

describe.skipIf(!hasCli)('/model across accounts e2e', () => {
  test('lists every connected account under its header, filters, and switches account and model at once', async () => {
    const models = (ids: string[]) =>
      Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: req =>
          new URL(req.url).pathname.endsWith('/models')
            ? Response.json({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) })
            : new Response('not found', { status: 404 }),
      })
    const a = models(['model-a', 'model-a-mini'])
    const b = models(['model-b', 'coder-b'])
    const { configDir, cwd } = makeSandbox()
    const accountsPath = join(configDir, 'accounts.json')
    writeFileSync(
      accountsPath,
      JSON.stringify({
        active: 'accta',
        accounts: {
          accta: { provider: 'custom', baseUrl: `http://127.0.0.1:${a.port}/v1`, model: 'model-a', label: 'Cuenta A' },
          acctb: { provider: 'custom', baseUrl: `http://127.0.0.1:${b.port}/v1`, model: 'model-b', label: 'Cuenta B' },
        },
      }),
    )
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, COLUMNS: '110', LINES: '40', TERM: 'xterm-256color' }
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_MULTIMODEL_') || ['CLAUDECODE', 'TMUX', 'ANTHROPIC_MODEL', 'FNHARNESS_ACCOUNT'].includes(k)) delete env[k]
    const proc = Bun.spawn(['script', '-qc', `timeout 16 ${CLI}`, '/dev/null'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const send = (t: string, ms: number) =>
      setTimeout(() => {
        proc.stdin.write(t)
        proc.stdin.flush()
      }, ms)
    send('/model', 5000)
    send('\r', 5600)
    send('coder', 8500)
    send('\r', 10500)
    const out = stripAnsi(await new Response(proc.stdout).text())
    await proc.exited
    a.stop(true)
    b.stop(true)
    // Ink moves the cursor instead of printing spaces: compare without whitespace.
    const flat = out.replace(/\s+/g, '')
    const has = (t: string) => expect(flat).toContain(t.replace(/\s+/g, ''))
    has('── Cuenta A (accta) · cuenta activa ──')
    has('● model-a')
    has('── Cuenta B (acctb) ──')
    has('── Claude (Anthropic) (claude) ──')
    has('Filtro: coder')
    expect(flat).toMatch(/Cuentaactiva:.*\(acctb\)·modelocoder-b/)
    // Remembered for the account and made the active one, like /account acctb coder-b.
    const saved = JSON.parse(readFileSync(accountsPath, 'utf8'))
    expect(saved.active).toBe('acctb')
    expect(saved.accounts.acctb.model).toBe('coder-b')
  }, 40_000)
})

describe.skipIf(!hasCli)('subagent panel shows the account e2e', () => {
  test('a background agent on another account is listed with cuenta:modelo', async () => {
    const tool = { name: 'Agent', args: { description: 'contar en B', prompt: 'SUB_PANEL tarea', subagent_type: 'general-purpose', model: 'acctb:model-b', run_in_background: true } }
    const a = fakeServer('model-a', b => {
      const msgs = b.messages ?? []
      const asked = msgs.some(m => m.role === 'user' && text(m).includes('LANZA_PANEL'))
      return asked && !msgs.some(m => m.role === 'tool') ? { tool } : { text: 'ok' }
    })
    // B answers late so the row stays in the panel while we look.
    const b = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (new URL(req.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'model-b' }] })
        await Bun.sleep(9000)
        return new Response(sse('model-b', { content: 'hecho' }, 'stop'), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const { configDir, cwd } = makeSandbox()
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({
        active: 'accta',
        accounts: {
          accta: { provider: 'custom', baseUrl: a.baseUrl, model: 'model-a' },
          acctb: { provider: 'custom', baseUrl: `http://127.0.0.1:${b.port}/v1`, model: 'model-b' },
        },
      }),
    )
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, COLUMNS: '110', LINES: '30', TERM: 'xterm-256color', FNHARNESS_DISABLE_MODELS_FETCH: '1', FNHARNESS_CONTEXT_PROFILE: 'full' }
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_MULTIMODEL_') || ['CLAUDECODE', 'TMUX', 'ANTHROPIC_MODEL', 'FNHARNESS_ACCOUNT'].includes(k)) delete env[k]
    const proc = Bun.spawn(['script', '-qc', `timeout 14 ${CLI}`, '/dev/null'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    setTimeout(() => {
      proc.stdin.write('LANZA_PANEL')
      proc.stdin.flush()
    }, 5000)
    setTimeout(() => {
      proc.stdin.write('\r')
      proc.stdin.flush()
    }, 5500)
    const out = stripAnsi(await new Response(proc.stdout).text()).replace(/\s+/g, '')
    await proc.exited
    a.stop()
    b.stop(true)
    expect(out).toMatch(/◯general-purpose·acctb:model-b(\([^)]*\))?·contarenB/)
  }, 40_000)
})
