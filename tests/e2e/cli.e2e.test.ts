/**
 * End-to-end tests against the built ./cli (run `bun run build` first; they
 * are skipped when the binary is missing). No real provider is contacted:
 * every model call goes to a fake OpenAI-compatible server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CLI,
  captureTui,
  fakeEnv,
  hasCli,
  makeSandbox,
  startFakeOpenAI,
} from './harness.js'

const REPLY = 'hola desde el backend falso'
let fake: ReturnType<typeof startFakeOpenAI>

beforeAll(() => {
  fake = startFakeOpenAI(REPLY)
})
afterAll(() => fake.stop())

describe.skipIf(!hasCli)('cli e2e', () => {
  test('--version shows the FnHarness and upstream versions', () => {
    const out = Bun.spawnSync([CLI, '--version']).stdout.toString()
    expect(out).toMatch(/^FnHarness \d+\.\d+\.\d+ \(base Claude Code \d+\.\d+\.\d+\)/)
  })

  test('-p round-trips through the OpenAI-compatible adapter', async () => {
    const { configDir, cwd } = makeSandbox()
    // Async spawn: a sync one would block this process, which also serves the
    // fake backend, and the request would never be answered.
    const proc = Bun.spawn([CLI, '-p', 'di hola'], {
      cwd,
      env: fakeEnv(fake.baseUrl, configDir),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain(REPLY)
    expect(fake.requests.length).toBeGreaterThan(0)
  }, 70_000)

  test('--fallback-model falls back across accounts when the primary is down', async () => {
    const { configDir, cwd } = makeSandbox()
    // The "backup" account points at the fake server; the primary at a closed port.
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({ accounts: { backup: { provider: 'custom', baseUrl: fake.baseUrl, model: 'fake-model' } } }),
    )
    const before = fake.requests.length
    const proc = Bun.spawn([CLI, '-p', '--fallback-model', 'backup', 'di hola'], {
      cwd,
      env: fakeEnv('http://127.0.0.1:1/v1', configDir),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 90_000,
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain(REPLY)
    expect(fake.requests.length).toBeGreaterThan(before)
  }, 100_000)

  test('without a fallback chain a dead primary is an error', async () => {
    const { configDir, cwd } = makeSandbox()
    const proc = Bun.spawn([CLI, '-p', 'di hola'], {
      cwd,
      env: fakeEnv('http://127.0.0.1:1/v1', configDir, { CLAUDE_CODE_MAX_RETRIES: '1' }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).not.toContain(REPLY)
  }, 70_000)

  test('PostToolBatch hook receives the batch and its context reaches the model', async () => {
    const { configDir, cwd } = makeSandbox()
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const bodies: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/chat/completions')) return Response.json({ data: [] })
        const body = (await req.json()) as { messages: Array<{ role: string }> }
        bodies.push(JSON.stringify(body.messages))
        const done = body.messages.some(m => m.role === 'tool')
        const sse = done
          ? chunk({ role: 'assistant', content: 'listo' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'
          : chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hi', description: 'x' }) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const out = join(cwd, 'batch.json')
      const settings = JSON.stringify({
        hooks: { PostToolBatch: [{ hooks: [{ type: 'command', command: `cat > ${out}; echo '{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"CTX-DEL-LOTE"}}'` }] }] },
      })
      const proc = Bun.spawn([CLI, '-p', '--dangerously-skip-permissions', '--settings', settings, 'corre echo'], {
        cwd,
        env: fakeEnv(`http://127.0.0.1:${server.port}/v1`, configDir),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
      })
      expect(await new Response(proc.stdout).text()).toContain('listo')
      await proc.exited
      const input = JSON.parse(readFileSync(out, 'utf8'))
      expect(input.hook_event_name).toBe('PostToolBatch')
      expect(input.tool_calls).toHaveLength(1)
      expect(input.tool_calls[0]).toMatchObject({ tool_name: 'Bash', tool_use_id: 'call_1' })
      expect(bodies.at(-1)).toContain('CTX-DEL-LOTE')
    } finally {
      server.stop(true)
    }
  }, 70_000)

  test('TUI header and footer with mocks', async () => {
    const { configDir, cwd } = makeSandbox()
    const mocks = join(configDir, 'mocks.json')
    writeFileSync(
      mocks,
      JSON.stringify({
        shells: 2,
        monitors: 1,
        agents: 3,
        permissionMode: 'plan',
        accounts: 4,
        models: 120,
      }),
    )
    const lines = await captureTui(
      fakeEnv(fake.baseUrl, configDir, { FNHARNESS_MOCKS: mocks }),
      cwd,
    )
    const text = lines.join('\n')
    expect(text).toMatch(/FnHarness ?v\d+\.\d+\.\d+ · base \d+\.\d+\.\d+/)
    expect(text).toContain(`custom · fake-model`)
    expect(text).toContain('4 cuentas conectadas · 120 modelos')
    expect(text).toContain('plan mode on')
    expect(text).toContain('2 shells · 1 monitor · 3 agents')
    // Logo (terminal window with an ƒ prompt)
    expect(text).toContain('▌ > ƒ_  ▐')
  }, 30_000)

  test('TUI idle footer without mocks', async () => {
    const { configDir, cwd } = makeSandbox()
    const text = (await captureTui(fakeEnv(fake.baseUrl, configDir), cwd)).join('\n')
    expect(text).toContain('default mode')
    expect(text).toContain('0 shells · 0 monitors · 0 agents')
  }, 30_000)
})
