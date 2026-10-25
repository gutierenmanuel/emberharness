/**
 * Context profile (/scope) end to end: what the model receives with each
 * preset. Uses the fake OpenAI-compatible server; no real provider.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, fakeEnv, hasCli, makeSandbox, startFakeOpenAI, stripAnsi } from './harness.js'

type ChatBody = {
  stream?: boolean
  tools?: Array<{ function: { name: string } }>
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>
}

let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI('vale')
})
afterAll(() => fake.stop())

async function runPrint(env: Record<string, string | undefined>, cwd: string, args: string[]) {
  const proc = Bun.spawn([CLI, '-p', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

/** Main-loop requests (streaming) sent during `fn`. */
async function capture(fn: () => Promise<unknown>): Promise<ChatBody[]> {
  const before = fake.requests.length
  await fn()
  return (fake.requests.slice(before) as ChatBody[]).filter(r => r.stream !== false)
}

const toolNames = (b: ChatBody) => (b.tools ?? []).map(t => t.function.name).sort()
const SIMPLE = ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']

describe.skipIf(!hasCli)('context profile e2e', () => {
  test('a local account starts in Simple: exactly the seven basic tools are sent', async () => {
    const { configDir, cwd } = makeSandbox()
    const reqs = await capture(() => runPrint(fakeEnv(fake.baseUrl, configDir), cwd, ['di hola']))
    expect(reqs.length).toBeGreaterThan(0)
    expect(toolNames(reqs[0]!)).toEqual(SIMPLE)
  }, 70_000)

  test('Simple sends a compact system prompt and compact tool descriptions', async () => {
    const { configDir, cwd } = makeSandbox()
    const [simple] = await capture(() => runPrint(fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'simple' }), cwd, ['di hola']))
    const [full] = await capture(() => runPrint(fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full' }), cwd, ['di hola']))
    const system = (b: ChatBody) => JSON.stringify(b.messages.filter(m => m.role === 'system'))
    const toolsJson = (b: ChatBody) => JSON.stringify(b.tools ?? [])
    expect(toolNames(simple!)).toEqual(SIMPLE)
    // Own short prompt: identity and environment, not the Claude Code agent prompt.
    expect(system(simple!)).toContain('fnharness')
    expect(system(simple!)).toContain(cwd)
    // Whole fixed cost (system + tool definitions) stays under ~4k tokens (chars / 4).
    expect((system(simple!).length + toolsJson(simple!).length) / 4).toBeLessThan(4000)
    expect(system(simple!).length).toBeLessThan(system(full!).length / 4)
    // Input schemas keep names, types, enums and required lists as in Full; only the
    // per-parameter description text is shortened (FNHARNESS_LOCAL_SCHEMA_DESC_MAX).
    const params = (b: ChatBody, n: string) =>
      JSON.stringify((b.tools as any[]).find(t => t.function.name === n).function.parameters, (k, v) => (k === 'description' && typeof v === 'string' ? undefined : v))
    for (const n of SIMPLE) expect(params(simple!, n)).toBe(params(full!, n))
  }, 140_000)

  test('a profile saved for the account in accounts.json is honoured', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({ active: 'local', accounts: { local: { provider: 'custom', baseUrl: fake.baseUrl, model: 'fake-model', contextProfile: { mcp: 'none', skill: 'none', tools: 'none' } } } }),
    )
    const env = { ...fakeEnv(fake.baseUrl, configDir) }
    delete env.CLAUDE_MULTIMODEL_PROVIDER
    delete env.CLAUDE_MULTIMODEL_BASE_URL
    delete env.CLAUDE_MULTIMODEL_MODEL
    const reqs = await capture(() => runPrint(env, cwd, ['di hola']))
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs[0]!.tools ?? []).toEqual([])
  }, 70_000)

  test('Full sends more than Simple; Nothing sends no tools and a short prompt', async () => {
    const { configDir, cwd } = makeSandbox()
    const full = await capture(() => runPrint(fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full' }), cwd, ['di hola']))
    const nothing = await capture(() => runPrint(fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'nothing' }), cwd, ['di hola']))
    expect(toolNames(full[0]!).length).toBeGreaterThan(SIMPLE.length)
    expect(toolNames(full[0]!)).toContain('Skill')
    expect(nothing[0]!.tools ?? []).toEqual([])
    const sys = (b: ChatBody) => JSON.stringify(b.messages.filter(m => m.role === 'system'))
    expect(sys(nothing[0]!).length).toBeLessThan(sys(full[0]!).length / 2)
  }, 140_000)

  test('switching to Nothing after tool calls keeps the conversation valid', async () => {
    const { configDir, cwd } = makeSandbox()
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const bodies: ChatBody[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/chat/completions')) return Response.json({ data: [] })
        const body = (await req.json()) as ChatBody
        if (body.stream !== false) bodies.push(body)
        const wantsTool = (body.tools?.length ?? 0) > 0 && !body.messages.some(m => m.role === 'tool')
        const sse = wantsTool
          ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hi', description: 'x' }) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
          : chunk({ role: 'assistant', content: 'listo' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      expect(await runPrint(fakeEnv(base, configDir, { FNHARNESS_CONTEXT_PROFILE: 'simple' }), cwd, ['--dangerously-skip-permissions', 'corre echo'])).toContain('listo')
      const before = bodies.length
      const out = await runPrint(fakeEnv(base, configDir, { FNHARNESS_CONTEXT_PROFILE: 'nothing' }), cwd, ['--continue', 'y ahora?'])
      expect(out).toContain('listo')
      const last = bodies.slice(before).at(-1)!
      expect(last.tools ?? []).toEqual([])
      expect(last.messages.some(m => m.role === 'tool' || m.tool_calls)).toBe(false)
      expect(JSON.stringify(last.messages)).toContain('[tool call Bash')
    } finally {
      server.stop(true)
    }
  }, 140_000)

  test('Ctrl+Tab (kitty CSI u and xterm modifyOtherKeys) rotates the profile in the TUI', async () => {
    const { configDir, cwd } = makeSandbox()
    const env: Record<string, string | undefined> = { ...fakeEnv(fake.baseUrl, configDir), COLUMNS: '120', LINES: '30', TERM: 'xterm-256color' }
    delete env.TMUX
    const proc = Bun.spawn(['script', '-qfc', `stty cols 120 rows 30; timeout 14 ${CLI}`, '/dev/null'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const output = new Response(proc.stdout).text()
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
    const saved = () => {
      try {
        return JSON.parse(readFileSync(join(configDir, 'accounts.json'), 'utf8')).accounts.custom?.contextProfile
      } catch {
        return undefined
      }
    }
    await wait(5000)
    const steps: unknown[] = []
    // simple → nothing (CSI 9;5u) → full (CSI 27;5;9~) → nothing (ctrl+shift+tab, CSI 9;6u)
    for (const seq of ['\x1b[9;5u', '\x1b[27;5;9~', '\x1b[9;6u']) {
      proc.stdin.write(seq)
      proc.stdin.flush()
      await wait(1500)
      steps.push(saved())
    }
    proc.kill()
    await proc.exited
    const text = stripAnsi(await output)
    expect(text).toContain('ctx: simple')
    expect(steps).toEqual([
      { mcp: 'none', skill: 'none', tools: 'none' },
      { mcp: 'full', skill: 'full', tools: 'full' },
      { mcp: 'none', skill: 'none', tools: 'none' },
    ])
  }, 30_000)
})
