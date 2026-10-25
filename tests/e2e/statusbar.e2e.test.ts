/**
 * Status bar input end to end. A fake llama.cpp on 127.0.0.1 answers /props with
 * its n_ctx; the real TUI runs with a statusLine command that dumps its stdin,
 * so the JSON the fork hands to statusline.sh can be checked: account, REAL
 * window from the server (not 200k, not a Claude name), output cap, server state.
 * Also: the default account is what a bare launch opens with.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { APP_DIR, FAKE_MODEL, fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'
import { startTui } from './tui.js'

const N_CTX = 16384
let server: ReturnType<typeof Bun.serve>
let baseUrl = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/props') {
        return Response.json({ default_generation_settings: { n_ctx: N_CTX }, model_alias: '/m/fake-gguf-model.gguf' })
      }
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      return new Response('nf', { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}/v1`
})
afterAll(() => server.stop(true))

async function waitForDump(path: string, ok: (j: any) => boolean, ms = 30_000): Promise<any> {
  const end = Date.now() + ms
  let last: any = null
  while (Date.now() < end) {
    if (existsSync(path)) {
      try {
        last = JSON.parse(readFileSync(path, 'utf8'))
        if (ok(last)) return last
      } catch {}
    }
    await Bun.sleep(200)
  }
  throw new Error(`statusLine input never matched; last: ${JSON.stringify(last)?.slice(0, 800)}`)
}

describe.skipIf(!hasCli)('status bar input e2e', () => {
  test('carries the account, the server n_ctx as the window and no Claude assumptions', async () => {
    const { configDir, cwd } = makeSandbox()
    const dump = join(configDir, 'statusline.json')
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `cat > ${dump}.tmp && mv ${dump}.tmp ${dump}`, refreshInterval: 1 } }))
    const tui = startTui(fakeEnv(baseUrl, configDir), cwd)
    try {
      const j = await waitForDump(dump, j => j.fnharness?.server?.n_ctx === N_CTX)
      expect(j.fnharness.account).toMatchObject({ provider: 'custom', local: true, model: FAKE_MODEL, server_model: 'fake-gguf-model' })
      expect(j.fnharness.context).toMatchObject({ window: N_CTX, source: 'server' })
      expect(j.fnharness.server).toMatchObject({ online: true, n_ctx: N_CTX })
      expect(j.fnharness.cost.kind).toBe('free')
      expect(j.context_window.context_window_size).toBe(N_CTX)
      expect(j.fnharness.context.autocompact_at).toBeLessThan(N_CTX)
      expect(j.fnharness.context.autocompact_at).toBeGreaterThan(N_CTX / 2)
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('a bare launch opens with the default account, not the last used one', async () => {
    const fake = startFakeOpenAI('hola')
    try {
      const { configDir, cwd } = makeSandbox()
      writeFileSync(
        join(configDir, 'accounts.json'),
        JSON.stringify({
          active: 'ultima',
          default: 'fija',
          accounts: {
            ultima: { provider: 'custom', baseUrl: fake.baseUrl, model: 'm-ultima' },
            fija: { provider: 'custom', baseUrl: fake.baseUrl, model: 'm-fija' },
          },
        }),
      )
      const env = { ...fakeEnv(fake.baseUrl, configDir) } as Record<string, string | undefined>
      for (const k of ['CLAUDE_MULTIMODEL_PROVIDER', 'CLAUDE_MULTIMODEL_BASE_URL', 'CLAUDE_MULTIMODEL_MODEL']) delete env[k]
      const proc = Bun.spawn([join(APP_DIR, 'bin', 'fnharness'), '-p', 'di hola', '--output-format', 'json'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
      await new Response(proc.stdout).text()
      await proc.exited
      expect((fake.requests[0] as { model: string }).model).toBe('m-fija')
    } finally {
      fake.stop()
    }
  }, 90_000)
})
