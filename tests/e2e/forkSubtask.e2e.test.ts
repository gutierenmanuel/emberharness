/**
 * /fork and /subtask: each launches one background subagent through the Agent
 * tool (scripted mock, scripts/mock_openai.ts). The fork child must receive the
 * parent's conversation; the subtask child must not.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_DIR, CLI, fakeEnv, hasCli, makeSandbox, stripAnsi } from './harness.js'

const PORT = 20000 + Math.floor(Math.random() * 20000)
const sandbox = makeSandbox()
const LOG = join(sandbox.cwd, 'mock.log')
let mock: ReturnType<typeof Bun.spawn>

beforeAll(async () => {
  mock = Bun.spawn(['bun', 'run', join(APP_DIR, 'scripts', 'mock_openai.ts'), String(PORT)], {
    env: { ...process.env, MOCK_LOG: LOG, MOCK_SUB_DELAY_MS: '6000' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/v1/models`)).ok) return
    } catch {}
    await Bun.sleep(100)
  }
})
afterAll(() => mock.kill())

type Body = { all: string }
const bodies = (): Body[] =>
  readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Body)
const flat = (b: Body) => b.all

describe.skipIf(!hasCli)('/fork and /subtask e2e', () => {
  test('fork inherits the conversation, subtask starts clean', async () => {
    const { configDir, cwd } = sandbox
    const env = { ...fakeEnv(`http://127.0.0.1:${PORT}/v1`, configDir, { CLAUDE_MULTIMODEL_MODEL: 'mock-model', FNHARNESS_CONTEXT_PROFILE: 'full' }), COLUMNS: '120', LINES: '30', TERM: 'xterm-256color' } as Record<string, string | undefined>
    delete env.TMUX
    const proc = Bun.spawn(['script', '-qc', `timeout 40 ${CLI}`, '/dev/null'], {
      cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const send = (ms: number, text: string) =>
      setTimeout(() => {
        proc.stdin.write(text)
        proc.stdin.flush()
      }, ms)
    send(6000, 'ECO: HISTORIA_PREVIA_XYZ\r')
    send(10000, '/fork FORK_DEMO\r')
    send(16000, '/subtask SUBTASK_DEMO\r')
    const out = stripAnsi(await new Response(proc.stdout).text())
    await proc.exited
    expect(out).toContain('Lanzando /fork en segundo plano')
    expect(out).toContain('Lanzando /subtask en segundo plano')
    expect(out).toMatch(/fork\s+fork demo\s+\d+s/)
    expect(out).toMatch(/general-purpose\s+subtask demo\s+\d/)

    const all = bodies()
    const forkChild = all.find(b => flat(b).includes('<fork-boilerplate>'))
    expect(forkChild).toBeDefined()
    expect(flat(forkChild!)).toContain('HISTORIA_PREVIA_XYZ')
    const subChild = all.find(b => flat(b).includes('SUBTASK_SUB work') && !flat(b).includes('The user ran /subtask'))
    expect(subChild).toBeDefined()
    expect(flat(subChild!)).not.toContain('HISTORIA_PREVIA_XYZ')
    expect(flat(subChild!)).not.toContain('<fork-boilerplate>')
  }, 70_000)
})
