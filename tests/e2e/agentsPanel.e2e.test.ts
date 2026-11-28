/**
 * Subagent panel under the prompt: two background agents started through the
 * scripted mock (scripts/mock_openai.ts, "AGENT_DEMO") must show up as rows
 * below the prompt, one per agent, while they run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { APP_DIR, CLI, fakeEnv, hasCli, makeSandbox, stripAnsi } from './harness.js'

const PORT = 20000 + Math.floor(Math.random() * 20000)
const PORT_FAST = PORT + 1
let mock: ReturnType<typeof Bun.spawn>
let mockFast: ReturnType<typeof Bun.spawn>

async function startMock(port: number, delayMs: string): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(['bun', 'run', join(APP_DIR, 'scripts', 'mock_openai.ts'), String(port)], {
    env: { ...process.env, MOCK_LOG: join(makeSandbox().cwd, 'mock.log'), MOCK_SUB_DELAY_MS: delayMs },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/models`)).ok) break
    } catch {}
    await Bun.sleep(100)
  }
  return proc
}

async function runTui(port: number, steps: [number, string][], seconds: number): Promise<string> {
  const { configDir, cwd } = makeSandbox()
  const env = { ...fakeEnv(`http://127.0.0.1:${port}/v1`, configDir, { CLAUDE_MULTIMODEL_MODEL: 'mock-model', FNHARNESS_CONTEXT_PROFILE: 'full' }), COLUMNS: '110', LINES: '34', TERM: 'xterm-256color' } as Record<string, string | undefined>
  delete env.TMUX
  const proc = Bun.spawn(['script', '-qc', `timeout ${seconds} ${CLI}`, '/dev/null'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  for (const [t, k] of steps) setTimeout(() => { proc.stdin.write(k); proc.stdin.flush() }, t)
  const out = stripAnsi(await new Response(proc.stdout).text())
  await proc.exited
  return out
}

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
beforeAll(async () => {
  mockFast = await startMock(PORT_FAST, '4000')
})
afterAll(() => {
  mock.kill()
  mockFast.kill()
})

describe.skipIf(!hasCli)('agents panel e2e', () => {
  test('background agents are listed under the prompt', async () => {
    const { configDir, cwd } = makeSandbox()
    const env = { ...fakeEnv(`http://127.0.0.1:${PORT}/v1`, configDir, { CLAUDE_MULTIMODEL_MODEL: 'mock-model', FNHARNESS_CONTEXT_PROFILE: 'full' }), COLUMNS: '120', LINES: '30', TERM: 'xterm-256color' } as Record<string, string | undefined>
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
    expect(out).toMatch(/◯ general-purpose · [^·\s]+:[^·]+ · count src\s+\d+s/)
    expect(out).toMatch(/◯ general-purpose · [^·\s]+:[^·]+ · count utils\s+\d+s/)
    expect(out).toContain('↓ to manage')
  }, 40_000)

  test('grouped launch tree, Explore, steering hint, finished notice and eviction', async () => {
    const down = '\u001b[B'
    const out = await runTui(PORT_FAST, [[6000, 'AGENT_PAR\r'], [9000, down], [9500, down], [10000, '\r']], 24)
    expect(out).toContain('2 background agents launched')
    expect(out).toMatch(/├ count src/)
    expect(out).toMatch(/└ count utils/)
    expect(out).toMatch(/◯ Explore · [^·\s]+:[^·]+ · count src/)
    expect(out).toContain('Message @Explore…')
    const out2 = await runTui(PORT_FAST, [[6000, 'AGENT_PAR\r']], 28)
    expect(out2).toMatch(/Agent "count src" finished · \d+s/)
    expect(out2).toMatch(/Agent "count utils" finished · \d+s/)
    expect(out2).toMatch(/◯ Explore · [^·\s]+:[^·]+ · count src/) // visible while running
    // Last frame: panel rows are gone after the grace period.
    const tail = out2.slice(out2.lastIndexOf('❯'))
    expect(tail).not.toContain('◯ Explore')
  }, 90_000)
})
