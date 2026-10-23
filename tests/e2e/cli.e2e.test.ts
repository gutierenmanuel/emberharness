/**
 * End-to-end tests against the built ./cli (run `bun run build` first; they
 * are skipped when the binary is missing). No real provider is contacted:
 * every model call goes to a fake OpenAI-compatible server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
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
