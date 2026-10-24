/**
 * Subagent panel under the prompt: two background agents started through the
 * scripted mock (scripts/mock_openai.ts, "AGENT_DEMO") must show up as rows
 * below the prompt, one per agent, while they run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { APP_DIR, CLI, fakeEnv, hasCli, makeSandbox, stripAnsi } from './harness.js'

const PORT = 20000 + Math.floor(Math.random() * 20000)
let mock: ReturnType<typeof Bun.spawn>

beforeAll(async () => {
  mock = Bun.spawn(['bun', 'run', join(APP_DIR, 'scripts', 'mock_openai.ts'), String(PORT)], {
    env: { ...process.env, MOCK_LOG: join(makeSandbox().cwd, 'mock.log'), MOCK_SUB_DELAY_MS: '15000' },
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

describe.skipIf(!hasCli)('agents panel e2e', () => {
  test('background agents are listed under the prompt', async () => {
    const { configDir, cwd } = makeSandbox()
    const env = { ...fakeEnv(`http://127.0.0.1:${PORT}/v1`, configDir, { CLAUDE_MULTIMODEL_MODEL: 'mock-model' }), COLUMNS: '120', LINES: '30', TERM: 'xterm-256color' } as Record<string, string | undefined>
    delete env.TMUX
    const proc = Bun.spawn(['script', '-qc', `timeout 22 ${CLI}`, '/dev/null'], {
      cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    setTimeout(() => {
      proc.stdin.write('AGENT_DEMO\r')
      proc.stdin.flush()
    }, 6000)
    const out = stripAnsi(await new Response(proc.stdout).text())
    await proc.exited
    expect(out).toContain('● main')
    expect(out).toMatch(/◯ general-purpose\s+count src\s+\d+s/)
    expect(out).toMatch(/◯ general-purpose\s+count utils\s+\d+s/)
    expect(out).toContain('↓ to manage')
  }, 40_000)
})
