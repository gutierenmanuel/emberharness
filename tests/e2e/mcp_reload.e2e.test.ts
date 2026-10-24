/**
 * MCP hot reload end to end, in the real TUI: a trivial stdio MCP server
 * (fixtures/mcp_stdio_server.ts) is added, edited and removed in .mcp.json
 * while the session stays open, and the tools the model gets in each request
 * (seen by the fake OpenAI backend) must follow.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'
import { startTui } from './tui.js'

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp_stdio_server.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI('listo')
})
afterAll(() => fake.stop())

type Req = { tools?: Array<{ function?: { name?: string } }> }
const toolNames = (r: unknown): string[] =>
  ((r as Req).tools ?? []).map(t => t.function?.name ?? '').filter(n => n.startsWith('mcp__'))

/** MCP tools of the newest request that carries a tools block (side calls such as titles have none). */
const lastToolNames = (requests: unknown[]): string[] => {
  for (let i = requests.length - 1; i >= 0; i--) {
    if (((requests[i] as Req).tools ?? []).length > 0) return toolNames(requests[i])
  }
  return []
}

function serverEntry(extraEnv: Record<string, string>) {
  return { command: process.execPath, args: [FIXTURE], env: extraEnv }
}

async function waitUntil(cond: () => boolean, ms = 20_000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await sleep(100)
  }
  throw new Error(`timeout: ${what}`)
}

describe.skipIf(!hasCli)('mcp hot reload (TUI)', () => {
  test('/mcp reload applies added, changed and removed servers (watcher off)', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const mcpJson = join(cwd, '.mcp.json')
    const entry = (tools: string) => serverEntry({ FIX_TOOLS: tools })
    writeFileSync(mcpJson, JSON.stringify({ mcpServers: { keep: entry('k1'), edit: entry('e1'), gone: entry('g1') } }))
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { FNHARNESS_MCP_WATCH: '0', ENABLE_TOOL_SEARCH: 'false' }), cwd)
    const ask = async (q: string) => {
      const n = fake.requests.length
      tui.line(q)
      await waitUntil(() => fake.requests.length > n, 30_000, 'request')
      await sleep(500)
      return lastToolNames(fake.requests.slice(n))
    }
    try {
      await tui.waitFor(/for shortcuts|bypass|simple mode|❯|>/i, 30_000)
      await sleep(3000)
      const first = await ask('uno')
      expect(first).toEqual(expect.arrayContaining(['mcp__keep__k1', 'mcp__edit__e1', 'mcp__gone__g1']))

      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { keep: entry('k1'), edit: entry('e2'), fresh: entry('f1') } }))
      tui.line('/mcp reload')
      await tui.waitFor('added: fresh', 20_000)
      await tui.waitFor('changed: edit', 5_000)
      await tui.waitFor('removed: gone', 5_000)
      await sleep(2500)
      const second = await ask('dos')
      expect(second).toEqual(expect.arrayContaining(['mcp__keep__k1', 'mcp__edit__e2', 'mcp__fresh__f1']))
      expect(second).not.toContain('mcp__gone__g1')
      expect(second).not.toContain('mcp__edit__e1')

      // Invalid JSON: nothing is touched.
      writeFileSync(mcpJson, '{"mcpServers": {"x":')
      tui.line('/mcp reload')
      await tui.waitFor('not valid JSON yet', 20_000)
      const third = await ask('tres')
      expect(third).toEqual(expect.arrayContaining(['mcp__keep__k1', 'mcp__edit__e2', 'mcp__fresh__f1']))
    } finally {
      await tui.stop()
    }
  }, 180_000)
  test.skip('add, auto-reconnect and remove a stdio server with the session open', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const pidFile = join(cwd, 'alpha.pid')
    const logFile = join(cwd, 'alpha.log')
    const mcpJson = join(cwd, '.mcp.json')
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { ENABLE_TOOL_SEARCH: 'false' }), cwd)
    try {
      await tui.waitFor(/for shortcuts|bypass|simple mode|❯|>/i, 30_000)
      await sleep(1500)

      // 1. add the server while the session is open
      writeFileSync(
        mcpJson,
        JSON.stringify({ mcpServers: { alpha: serverEntry({ FIX_TOOLS: 'echo', FIX_PID_FILE: pidFile, FIX_LOG_FILE: logFile }) } }),
      )
      await tui.waitFor('MCP: +alpha', 20_000)
      await waitUntil(() => existsSync(pidFile), 20_000, 'server started')
      const before = fake.requests.length
      tui.line('hola uno')
      await waitUntil(() => fake.requests.length > before, 30_000, 'request after add')
      expect(lastToolNames(fake.requests.slice(before))).toContain('mcp__alpha__echo')

      // 2. kill the process: it must come back by itself
      const starts = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(l => l === 'start').length : 0)
      expect(starts()).toBe(1)
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      await waitUntil(() => starts() >= 2, 30_000, 'auto reconnect')

      // 3. remove it: the tool disappears from the next request
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: {} }))
      await tui.waitFor('MCP: -alpha', 20_000)
      await sleep(500)
      const before2 = fake.requests.length
      tui.line('hola dos')
      await waitUntil(() => fake.requests.length > before2, 30_000, 'request after remove')
      expect(lastToolNames(fake.requests.slice(before2))).not.toContain('mcp__alpha__echo')
    } finally {
      await tui.stop()
    }
  }, 180_000)
})
