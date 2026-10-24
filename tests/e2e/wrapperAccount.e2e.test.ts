/**
 * bin/fnharness accepts --account in any position. The Matrix terminal launcher
 * appends it after --dangerously-skip-permissions and --session-id, and the CLI
 * itself rejects the flag ("unknown option '--account'"), so the wrapper has to
 * consume it wherever it appears. No real provider is contacted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { APP_DIR, fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'

const REPLY = 'respuesta de la cuenta piloto'
let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI(REPLY)
})
afterAll(() => fake.stop())

async function run(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const { configDir, cwd } = makeSandbox()
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ accounts: { piloto: { provider: 'custom', baseUrl: fake.baseUrl, model: 'fake-model' } } }),
  )
  const env = { ...fakeEnv(fake.baseUrl, configDir) } as Record<string, string | undefined>
  // fakeEnv forces a "custom" provider; the account under test must be the one that resolves it.
  delete env.CLAUDE_MULTIMODEL_PROVIDER
  delete env.CLAUDE_MULTIMODEL_BASE_URL
  delete env.CLAUDE_MULTIMODEL_MODEL
  const proc = Bun.spawn([join(APP_DIR, 'bin', 'fnharness'), ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { out, err, code: await proc.exited }
}

describe.skipIf(!hasCli)('bin/fnharness --account', () => {
  test('leading position', async () => {
    const r = await run(['--account', 'piloto', '-p', 'di hola'])
    expect(r.out).toContain(REPLY)
  }, 70_000)

  test('after other flags, as the Matrix launcher passes it', async () => {
    const r = await run(['--dangerously-skip-permissions', '--session-id', crypto.randomUUID(), '--account', 'piloto', '-p', 'di hola'])
    expect(r.err).not.toContain("unknown option '--account'")
    expect(r.out).toContain(REPLY)
  }, 70_000)

  test('--account=ID form', async () => {
    const r = await run(['-p', '--account=piloto', 'di hola'])
    expect(r.out).toContain(REPLY)
  }, 70_000)
})
