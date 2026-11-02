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

/**
 * --accounts and --set-default list known accounts from the wrapper itself (no CLI). The
 * provider presets live in src/config/defaults/providers.json; when the wrapper still grepped
 * the old profiles.ts, the empty match aborted the block under set -e and only "claude" was
 * listed, so saved accounts were unknown to --set-default too.
 */
describe('bin/fnharness --accounts', () => {
  function wrapper(args: string[], configDir: string) {
    return Bun.spawnSync([join(APP_DIR, 'bin', 'fnharness'), ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  test('lists presets, user providers and saved accounts', () => {
    const { configDir } = makeSandbox()
    writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ accounts: { piloto: { provider: 'custom' } } }))
    writeFileSync(join(configDir, 'providers.json'), JSON.stringify({ providers: { miprov: { baseUrl: 'http://x' } } }))
    const ids = wrapper(['--accounts'], configDir).stdout.toString().split('\n').map(l => l.split(' ')[0])
    expect(ids).toContain('claude')
    expect(ids).toContain('venice')
    expect(ids).toContain('miprov')
    expect(ids).toContain('piloto')
    expect(ids).not.toContain('custom')
  })

  test('--set-default accepts a saved account', () => {
    const { configDir } = makeSandbox()
    writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ accounts: { piloto: { provider: 'custom' } } }))
    const r = wrapper(['--set-default', 'piloto'], configDir)
    expect(r.exitCode).toBe(0)
    expect(wrapper(['--accounts'], configDir).stdout.toString()).toContain('piloto (predeterminada)')
  })
})
