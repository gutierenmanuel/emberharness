/**
 * Small pack end to end: mcp_tool hooks, UserPromptExpansion, MessageDisplay
 * and Esc on a pending /loop wake-up. Fake OpenAI backend; no real provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'
import { startTui } from './tui.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp_stdio_server.ts')
const REPLY = 'respuesta original del modelo'
let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI(REPLY)
})
afterAll(() => fake.stop())

async function runP(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn([CLI, '-p', '--dangerously-skip-permissions', ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

const lastUserText = (requests: unknown[]): string =>
  JSON.stringify((requests.at(-1) as { messages: unknown }).messages)

describe.skipIf(!hasCli)('small pack e2e', () => {
  test('mcp_tool hook calls the MCP tool with substituted input and its JSON reaches the model', async () => {
    const { configDir, cwd } = makeSandbox()
    const log = join(cwd, 'calls.jsonl')
    const mcpConfig = join(cwd, 'mcp.json')
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [FIXTURE],
            env: {
              FIX_CALL_LOG: log,
              FIX_CALL_REPLY: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CTX-DEL-MCP-TOOL"}}',
            },
          },
        },
      }),
    )
    const settings = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'mcp_tool', server: 'fixture', tool: 'echo', input: { text: 'p=${prompt}', cwd: '${cwd}' } }] },
        ],
      },
    })
    const before = fake.requests.length
    const out = await runP(['--mcp-config', mcpConfig, '--settings', settings, 'hola mundo'], cwd, fakeEnv(fake.baseUrl, configDir))
    expect(out).toContain(REPLY)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(calls[0].name).toBe('echo')
    expect(calls[0].arguments.text).toBe('p=hola mundo')
    expect(calls[0].arguments.cwd).toBeTruthy()
    expect(fake.requests.length).toBeGreaterThan(before)
    expect(lastUserText(fake.requests)).toContain('CTX-DEL-MCP-TOOL')
  }, 70_000)

  test('mcp_tool hook to an unknown server is a non-blocking error', async () => {
    const { configDir, cwd } = makeSandbox()
    const settings = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'mcp_tool', server: 'nope', tool: 'x' }] }] },
    })
    const out = await runP(['--settings', settings, 'hola'], cwd, fakeEnv(fake.baseUrl, configDir))
    expect(out).toContain(REPLY)
  }, 70_000)

  function commandSandbox() {
    const sb = makeSandbox()
    mkdirSync(join(sb.cwd, '.claude', 'skills', 'saluda'), { recursive: true })
    writeFileSync(
      join(sb.cwd, '.claude', 'skills', 'saluda', 'SKILL.md'),
      '---\nname: saluda\ndescription: Saluda a alguien\n---\nSaluda a $ARGUMENTS con cariño.\n',
    )
    return sb
  }

  test('UserPromptExpansion hook gets the command and its context reaches the model', async () => {
    const { configDir, cwd } = commandSandbox()
    const out = join(cwd, 'expansion.json')
    const settings = JSON.stringify({
      hooks: {
        UserPromptExpansion: [
          {
            matcher: 'saluda',
            hooks: [{ type: 'command', command: `cat > ${out}; echo '{"hookSpecificOutput":{"hookEventName":"UserPromptExpansion","additionalContext":"CTX-EXPANSION"}}'` }],
          },
        ],
      },
    })
    const text = await runP(['--settings', settings, '/saluda Ana Maria'], cwd, fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full' }))
    expect(text).toContain(REPLY)
    const input = JSON.parse(readFileSync(out, 'utf8'))
    expect(input).toMatchObject({
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'saluda',
      command_args: 'Ana Maria',
      prompt: '/saluda Ana Maria',
    })
    expect(lastUserText(fake.requests)).toContain('CTX-EXPANSION')
  }, 70_000)

  test('UserPromptExpansion hook can block the expansion with exit 2', async () => {
    const { configDir, cwd } = commandSandbox()
    const settings = JSON.stringify({
      hooks: { UserPromptExpansion: [{ hooks: [{ type: 'command', command: 'echo "comando prohibido" >&2; exit 2' }] }] },
    })
    const before = fake.requests.length
    const text = await runP(['--settings', settings, '/saluda Ana'], cwd, fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full' }))
    expect(text).not.toContain(REPLY)
    expect(fake.requests.length).toBe(before)
  }, 70_000)

  test('MessageDisplay hook replaces the text shown in the TUI only', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          MessageDisplay: [
            { hooks: [{ type: 'command', command: `cat >/dev/null; echo '{"hookSpecificOutput":{"hookEventName":"MessageDisplay","displayContent":"TEXTO-REEMPLAZADO"}}'` }] },
          ],
        },
      }),
    )
    const tui = startTui(fakeEnv(fake.baseUrl, configDir), cwd)
    try {
      await tui.waitFor(/❯|>/, 30_000)
      tui.line('hola')
      await tui.waitFor('TEXTO-REEMPLAZADO', 30_000)
      expect(tui.text()).not.toContain(REPLY)
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('Esc cancels a pending autopaced /loop wake-up', async () => {
    const { configDir, cwd } = makeSandbox()
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/chat/completions')) return Response.json({ data: [] })
        const body = (await req.json()) as { messages: Array<{ role: string }>; tools?: unknown[] }
        const done = body.messages.some(m => m.role === 'tool')
        const wantsTool = !done && (body.tools ?? []).length > 0
        const sse = wantsTool
          ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'ScheduleWakeup', arguments: JSON.stringify({ delaySeconds: 3600, prompt: '/loop vigila', reason: 'prueba' }) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
          : chunk({ role: 'assistant', content: 'volveré en una hora' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const tui = startTui(fakeEnv(`http://127.0.0.1:${server.port}/v1`, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full' }), cwd)
    try {
      await tui.waitFor(/❯|>/, 30_000)
      tui.line('programa una vuelta')
      await tui.waitFor('volveréenunahora', 40_000)
      await new Promise(r => setTimeout(r, 1500))
      tui.type('\x1b')
      await tui.waitFor('Pending wakeup cancelled', 15_000)
    } finally {
      await tui.stop()
      server.stop(true)
    }
  }, 120_000)
})
