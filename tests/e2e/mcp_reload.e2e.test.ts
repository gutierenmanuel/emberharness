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
  test('the watcher picks up an added, edited and removed server with the session open', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const mcpJson = join(cwd, '.mcp.json')
    const entry = (tools: string) => serverEntry({ FIX_TOOLS: tools })
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { ENABLE_TOOL_SEARCH: 'false' }), cwd)
    const ask = async (q: string) => {
      const n = fake.requests.length
      tui.line(q)
      await waitUntil(() => fake.requests.length > n, 30_000, 'request')
      await sleep(500)
      return lastToolNames(fake.requests.slice(n))
    }
    try {
      await tui.waitFor(/for shortcuts|bypass|simple mode|❯|>/i, 30_000)
      await sleep(2000)

      // add
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { alpha: entry('a1') } }))
      await tui.waitFor('MCP: +alpha', 20_000)
      await sleep(1500)
      expect(await ask('uno')).toContain('mcp__alpha__a1')

      // half-written JSON: warned, nothing touched
      writeFileSync(mcpJson, '{"mcpServers": {"alpha":')
      await tui.waitFor('is not valid JSON yet', 20_000)
      expect(await ask('dos')).toContain('mcp__alpha__a1')

      // edit + add in one write
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { alpha: entry('a2'), beta: entry('b1') } }))
      await tui.waitFor('MCP: +beta, ~alpha', 20_000)
      await sleep(1500)
      const third = await ask('tres')
      expect(third).toEqual(expect.arrayContaining(['mcp__alpha__a2', 'mcp__beta__b1']))
      expect(third).not.toContain('mcp__alpha__a1')

      // remove (let the previous turn and its toast settle first)
      await sleep(4000)
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { beta: entry('b1') } }))
      // (the toast is repainted incrementally over the previous one, so it is
      // not reliable to scrape: check what the model receives instead)
      await sleep(4000)
      const fourth = await ask('cuatro')
      expect(fourth).toContain('mcp__beta__b1')
      expect(fourth).not.toContain('mcp__alpha__a2')

      // user scope: mcpServers inside the global .claude.json
      const globalFile = join(configDir, '.claude.json')
      const cfg = JSON.parse(readFileSync(globalFile, 'utf8'))
      cfg.mcpServers = { usr: entry('u1') }
      writeFileSync(globalFile, JSON.stringify(cfg))
      await sleep(4000)
      expect(await ask('cinco')).toEqual(expect.arrayContaining(['mcp__beta__b1', 'mcp__usr__u1']))
    } finally {
      await tui.stop()
    }
  }, 240_000)

  test('a stdio server that dies is relaunched by itself', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const pidFile = join(cwd, 'alpha.pid')
    const logFile = join(cwd, 'alpha.log')
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { alpha: serverEntry({ FIX_TOOLS: 'echo', FIX_PID_FILE: pidFile, FIX_LOG_FILE: logFile }) } }),
    )
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { ENABLE_TOOL_SEARCH: 'false' }), cwd)
    const starts = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(l => l === 'start').length : 0)
    try {
      await waitUntil(() => starts() === 1 && existsSync(pidFile), 40_000, 'first start')
      await sleep(2000)
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      await waitUntil(() => starts() >= 2, 30_000, 'auto reconnect')
      const n = fake.requests.length
      tui.line('hola')
      await waitUntil(() => fake.requests.length > n, 30_000, 'request')
      await sleep(500)
      expect(lastToolNames(fake.requests.slice(n))).toContain('mcp__alpha__echo')
    } finally {
      await tui.stop()
    }
  }, 180_000)

  test('a server that crashes on every start is abandoned after the attempt budget', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const logFile = join(cwd, 'loop.log')
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { loop: serverEntry({ FIX_TOOLS: 'echo', FIX_LOG_FILE: logFile, FIX_DIE_AFTER_MS: '300' }) } }),
    )
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { ENABLE_TOOL_SEARCH: 'false' }), cwd)
    const starts = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(l => l === 'start').length : 0)
    try {
      // 1 launch + 4 restarts (backoff 1+2+4+8 s), then it must stop.
      await waitUntil(() => starts() >= 5, 60_000, 'restarts')
      await sleep(12_000)
      expect(starts()).toBe(5)
    } finally {
      await tui.stop()
    }
  }, 120_000)

  test('the model is told once when the tools of a server change, and not otherwise', async () => {
    const { configDir, cwd } = makeSandbox()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const toolsFile = join(cwd, 'tools.txt')
    writeFileSync(toolsFile, 'one,two')
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { dyn: serverEntry({ FIX_TOOLS_FILE: toolsFile }) } }))
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { ENABLE_TOOL_SEARCH: 'false' }), cwd)
    const PHRASE = 'tools of some MCP servers changed'
    const lastWithTools = (from: number): string => {
      const reqs = fake.requests.slice(from)
      for (let i = reqs.length - 1; i >= 0; i--) {
        if (((reqs[i] as Req).tools ?? []).length > 0) return JSON.stringify(reqs[i])
      }
      return ''
    }
    const ask = async (q: string) => {
      const n = fake.requests.length
      tui.line(q)
      await waitUntil(() => fake.requests.length > n, 30_000, 'request')
      await sleep(800)
      return lastWithTools(n)
    }
    try {
      await tui.waitFor(/for shortcuts|bypass|simple mode|❯|>/i, 30_000)
      await sleep(4000)
      const first = await ask('uno')
      expect(first).toContain('mcp__dyn__one')
      expect(first).not.toContain(PHRASE)

      writeFileSync(toolsFile, 'two,three')
      await sleep(3000)
      const second = await ask('dos')
      expect(second).toContain(PHRASE)
      expect(second).toContain('now available: mcp__dyn__three')
      expect(second).toContain('no longer available: mcp__dyn__one')
      expect(second.split(PHRASE).length - 1).toBe(1)
      await sleep(2000)

      // nothing changed since: no second notice in the history
      const third = await ask('tres')
      expect(third.split(PHRASE).length - 1).toBe(1)
    } finally {
      await tui.stop()
    }
  }, 180_000)
})
