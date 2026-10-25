/**
 * Tools that must work from the compiled ./cli, and the local-only behaviours:
 *  - Grep and Glob find files (ripgrep from the system or vendor/, never the virtual $bunfs path).
 *  - Edit on a file that was never Read works on a local account and keeps the upstream
 *    "File has not been read yet" guard on a remote one.
 *  - Local accounts start with --setting-sources user unless told otherwise.
 * A scripted fake OpenAI-compatible server drives the tool calls; no real provider.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, FAKE_MODEL, fakeEnv, hasCli, makeSandbox } from './harness.js'

type Msg = { role: string; content?: unknown; tool_call_id?: string }
type Body = { stream?: boolean; messages: Msg[] }
type Call = { name: string; args: object }

const sse = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

/** Fake server on `host`: answers the first main-loop request with `calls`, the next with a plain reply. */
function scriptedServer(host: string, calls: Call[]) {
  const requests: Body[] = []
  const server = Bun.serve({
    port: 0,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('nf', { status: 404 })
      const body = (await req.json()) as Body
      requests.push(body)
      if (body.stream === false) {
        return Response.json({ id: 'c', object: 'chat.completion', model: FAKE_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      }
      const toolTurn = !body.messages.some(m => m.role === 'tool')
      const out = toolTurn
        ? sse({ role: 'assistant', tool_calls: calls.map((c, i) => ({ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }) + sse({}, 'tool_calls')
        : sse({ role: 'assistant', content: 'listo' }) + sse({}, 'stop')
      return new Response(out + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  // Results ordered by the call index (call_0, call_1...), whatever order the harness ran them in.
  const toolResults = () => {
    const byId = new Map<string, string>()
    for (const r of requests) for (const m of r.messages) if (m.role === 'tool') byId.set(String(m.tool_call_id), JSON.stringify(m.content))
    return [...byId.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)
  }
  return { baseUrl: `http://${host}:${server.port}/v1`, requests, toolResults, stop: () => server.stop(true) }
}

async function run(env: Record<string, string | undefined>, cwd: string, args: string[] = ['haz']) {
  const proc = Bun.spawn([CLI, '-p', '--dangerously-skip-permissions', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

function project() {
  const sb = makeSandbox()
  mkdirSync(join(sb.cwd, 'src'))
  writeFileSync(join(sb.cwd, 'src', 'config.py'), 'TIMEOUT = 5\nNEEDLE_MARK = 1\n')
  writeFileSync(join(sb.cwd, 'notes.txt'), 'nothing here\n')
  return sb
}

const edit = (cwd: string): Call => ({
  name: 'Edit',
  args: { file_path: join(cwd, 'src', 'config.py'), old_string: 'TIMEOUT = 5', new_string: 'TIMEOUT = 30' },
})

describe.skipIf(!hasCli)('tools in the compiled binary', () => {
  test('Grep and Glob work (a real rg is found; no ENOENT on $bunfs)', async () => {
    const { configDir, cwd } = project()
    const srv = scriptedServer('127.0.0.1', [
      { name: 'Grep', args: { pattern: 'NEEDLE_MARK', path: cwd, output_mode: 'content' } },
      { name: 'Glob', args: { pattern: '**/*.py', path: cwd } },
    ])
    try {
      await run(fakeEnv(srv.baseUrl, configDir), cwd)
      const [grep, glob] = srv.toolResults()
      expect(grep).not.toContain('ENOENT')
      expect(grep).toContain('NEEDLE_MARK = 1')
      expect(glob).not.toContain('ENOENT')
      expect(glob).toContain('config.py')
      expect(glob).not.toContain('notes.txt')
    } finally {
      srv.stop()
    }
  }, 120_000)

  test('a shell function named rg does not count: PATH without a real rg still works through vendor/', async () => {
    const { configDir, cwd } = project()
    const srv = scriptedServer('127.0.0.1', [{ name: 'Grep', args: { pattern: 'TIMEOUT', path: cwd, output_mode: 'files_with_matches' } }])
    try {
      await run(fakeEnv(srv.baseUrl, configDir, { PATH: '/usr/bin:/bin' }), cwd)
      const [grep] = srv.toolResults()
      expect(grep).not.toContain('ENOENT')
      expect(grep).toContain('config.py')
    } finally {
      srv.stop()
    }
  }, 120_000)
})

describe.skipIf(!hasCli)('Edit without a prior Read', () => {
  test('local account (127.0.0.1): the edit is applied', async () => {
    const { configDir, cwd } = project()
    const srv = scriptedServer('127.0.0.1', [edit(cwd)])
    try {
      await run(fakeEnv(srv.baseUrl, configDir), cwd)
      expect(readFileSync(join(cwd, 'src', 'config.py'), 'utf8')).toContain('TIMEOUT = 30')
      expect(srv.toolResults()[0]).not.toContain('has not been read')
    } finally {
      srv.stop()
    }
  }, 120_000)

  test('remote account (not localhost): upstream guard "File has not been read yet" stays', async () => {
    const { configDir, cwd } = project()
    // 127.0.0.2 is loopback but not one of the "local" hosts, so it counts as a remote account.
    const srv = scriptedServer('127.0.0.2', [edit(cwd)])
    try {
      await run(fakeEnv(srv.baseUrl, configDir), cwd)
      expect(readFileSync(join(cwd, 'src', 'config.py'), 'utf8')).toContain('TIMEOUT = 5')
      expect(srv.toolResults()[0]).toContain('has not been read yet')
    } finally {
      srv.stop()
    }
  }, 120_000)
})

describe.skipIf(!hasCli)('lean setting sources on local accounts', () => {
  const claudeMdText = 'MARCA_CLAUDE_MD_DEL_PROYECTO'
  const prompt = (r: Body[]) => JSON.stringify(r[0]!.messages)

  async function firstRequest(extraEnv: Record<string, string>, args: string[]) {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(cwd, 'CLAUDE.md'), `${claudeMdText}\n`)
    const srv = scriptedServer('127.0.0.1', [])
    try {
      await run(fakeEnv(srv.baseUrl, configDir, extraEnv), cwd, [...args, 'di hola'])
      return prompt(srv.requests.filter(r => r.stream !== false))
    } finally {
      srv.stop()
    }
  }

  test('default: the project CLAUDE.md is not loaded', async () => {
    expect(await firstRequest({}, [])).not.toContain(claudeMdText)
  }, 120_000)
  test('FNHARNESS_LOCAL_LEAN=0 loads it again', async () => {
    expect(await firstRequest({ FNHARNESS_LOCAL_LEAN: '0' }, [])).toContain(claudeMdText)
  }, 120_000)
  test('an explicit --setting-sources wins', async () => {
    expect(await firstRequest({}, ['--setting-sources', 'user,project'])).toContain(claudeMdText)
  }, 120_000)
})
