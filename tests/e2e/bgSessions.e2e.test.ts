/**
 * Background sessions: `--bg`, `ps`, `logs`, `stop`, `attach`, `rm` against the
 * real ./cli with a fake OpenAI backend and a throwaway config dir.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { join } from 'path'
import { CLI, FAKE_MODEL, fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'

const REPLY = 'hecho en segundo plano'
let fake: ReturnType<typeof startFakeOpenAI>
let hang: ReturnType<typeof Bun.serve>

beforeAll(() => {
  fake = startFakeOpenAI(REPLY)
  // A backend that never answers chat requests, to keep a session running.
  hang = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      }
      return new Promise<Response>(() => {})
    },
  })
})
afterAll(() => {
  fake.stop()
  hang.stop(true)
})

function cli(env: Record<string, string | undefined>, cwd: string, ...args: string[]) {
  const r = Bun.spawnSync([CLI, ...args], { cwd, env, stdin: 'ignore' })
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
}

async function waitFor(fn: () => boolean, ms = 60_000) {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await Bun.sleep(250)
  return fn()
}

const idOf = (out: string) => /Sesión en segundo plano (\w{8})/.exec(out)?.[1] ?? ''
const psRow = (env: any, cwd: string, id: string) =>
  cli(env, cwd, 'ps').out.split('\n').find(l => l.startsWith(id)) ?? ''

describe.skipIf(!hasCli)('bg sessions e2e', () => {
  test('--bg runs detached, ps/logs show it, attach resumes the finished session, rm cleans', async () => {
    const { configDir, cwd } = makeSandbox()
    const env = fakeEnv(fake.baseUrl, configDir, { CLAUDE_MULTIMODEL_ACCOUNT: 'fakeacct' })
    delete (env as any).TMUX

    const launched = cli(env, cwd, '--bg', 'haz algo útil')
    expect(launched.code).toBe(0)
    const id = idOf(launched.out)
    expect(id).toHaveLength(8)
    // state lives under the config dir, nowhere else
    expect(existsSync(join(configDir, 'bg', id, 'meta.json'))).toBe(true)

    expect(await waitFor(() => psRow(env, cwd, id).includes(' done '))).toBe(true)
    const row = psRow(env, cwd, id)
    expect(row).toContain('fakeacct')
    expect(row).toContain('haz algo útil')

    const logs = cli(env, cwd, 'logs', id)
    expect(logs.out).toContain(REPLY)
    expect(logs.out).toContain('[fin: ok')
    // -f on a finished session drains the log and returns
    expect(cli(env, cwd, 'logs', id, '-f').out).toContain(REPLY)

    // attach on a finished session reopens it in the TUI via --resume
    const sessionId = JSON.parse(await Bun.file(join(configDir, 'bg', id, 'meta.json')).text()).sessionId
    const attached = Bun.spawn(['script', '-qc', `timeout 12 ${CLI} attach ${id}`, '/dev/null'], {
      cwd,
      env: { ...env, COLUMNS: '120', LINES: '30', TERM: 'xterm-256color' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const screen = await new Response(attached.stdout).text()
    await attached.exited
    expect(screen).toContain('haz algo')
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)

    expect(cli(env, cwd, 'rm', id).out).toContain('borrada')
    expect(cli(env, cwd, 'ps').out).toContain('No hay sesiones')
  }, 120_000)

  test('stop terminates a running session and ps reports it stopped', async () => {
    const { configDir, cwd } = makeSandbox()
    const env = fakeEnv(hang.hostname ? `http://127.0.0.1:${hang.port}/v1` : '', configDir)
    delete (env as any).TMUX

    const id = idOf(cli(env, cwd, '--bg', 'tarea larga').out)
    expect(id).toHaveLength(8)
    expect(psRow(env, cwd, id)).toContain(' running ')

    const stopped = cli(env, cwd, 'stop', id)
    expect(stopped.out).toContain('detenida')
    expect(await waitFor(() => psRow(env, cwd, id).includes(' stopped '), 10_000)).toBe(true)
    expect(cli(env, cwd, 'stop', id).out).toContain('ya no está en marcha')
  }, 60_000)

  test('unknown id and missing prompt fail with a message', () => {
    const { configDir, cwd } = makeSandbox()
    const env = fakeEnv(fake.baseUrl, configDir)
    expect(cli(env, cwd, 'logs', 'nope').code).toBe(1)
    expect(cli(env, cwd, '--bg').err).toContain('necesita un prompt')
  })
})
