import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCoalescedRunner,
  createDebouncer,
  fingerprintMcpFile,
  isMcpWatchEnabled,
  mcpWatchTargets,
  startMcpConfigWatcher,
} from './configWatcher.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('fingerprintMcpFile', () => {
  test('project: same servers in other key order give the same fingerprint', () => {
    const a = fingerprintMcpFile('project', '{"mcpServers":{"x":{"command":"a","args":[]}},"other":1}')
    const b = fingerprintMcpFile('project', '{"other":2,"mcpServers":{"x":{"args":[],"command":"a"}}}')
    expect(a).toEqual(b)
    expect(a.ok).toBe(true)
  })

  test('half-written or non-object JSON is not ok', () => {
    expect(fingerprintMcpFile('project', '{"mcpServers": {"x":').ok).toBe(false)
    expect(fingerprintMcpFile('global', '[1]').ok).toBe(false)
    expect(fingerprintMcpFile('global', '').ok).toBe(false)
  })

  test('missing file is a valid state', () => {
    expect(fingerprintMcpFile('project', null)).toEqual({ ok: true, value: 'missing' })
  })

  test('global ignores unrelated churn but sees user and project servers', () => {
    const base = { mcpServers: { u: { command: 'a' } }, projects: { '/p': { mcpServers: { l: { command: 'b' } }, cost: 1 } } }
    const churn = { ...base, numStartups: 9, projects: { '/p': { ...base.projects['/p'], cost: 2 } } }
    const edited = { ...base, projects: { '/p': { mcpServers: { l: { command: 'c' } } } } }
    const fp = (o: object) => fingerprintMcpFile('global', JSON.stringify(o))
    expect(fp(base)).toEqual(fp(churn))
    expect(fp(base)).not.toEqual(fp(edited))
  })
})

describe('mcpWatchTargets', () => {
  test('covers .mcp.json of cwd and ancestors plus the global file', () => {
    const t = mcpWatchTargets('/a/b/c', '/cfg/.claude.json')
    expect(t.projectFiles.has('/a/b/c/.mcp.json')).toBe(true)
    expect(t.projectFiles.has('/a/.mcp.json')).toBe(true)
    expect(t.files.has('/cfg/.claude.json')).toBe(true)
    expect(t.projectFiles.has('/cfg/.claude.json')).toBe(false)
    expect(t.dirs).toContain('/cfg')
  })
})

describe('timing helpers', () => {
  test('debouncer fires once after a burst', async () => {
    let n = 0
    const d = createDebouncer(30, () => n++)
    for (let i = 0; i < 10; i++) d.trigger()
    await sleep(80)
    expect(n).toBe(1)
  })

  test('coalesced runner never overlaps and reruns once', async () => {
    let running = 0
    let maxRunning = 0
    let runs = 0
    const r = createCoalescedRunner(async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      runs++
      await sleep(20)
      running--
    })
    await Promise.all([r.run(), r.run(), r.run(), r.run()])
    expect(maxRunning).toBe(1)
    expect(runs).toBe(2)
    await r.run()
    expect(runs).toBe(3)
  })

  test('FNHARNESS_MCP_WATCH=0 disables', () => {
    expect(isMcpWatchEnabled({})).toBe(true)
    expect(isMcpWatchEnabled({ FNHARNESS_MCP_WATCH: '0' })).toBe(false)
  })
})

describe('startMcpConfigWatcher (real files)', () => {
  test('reports a real change once, ignores churn and broken JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fnh-watch-'))
    const global = join(root, '.claude.json')
    const mcp = join(root, '.mcp.json')
    writeFileSync(global, '{"numStartups":1}')
    const changes: string[] = []
    const invalid: string[] = []
    const w = await startMcpConfigWatcher({
      cwd: root,
      globalFile: global,
      debounceMs: 50,
      pollMs: 50,
      onChange: p => changes.push(p),
      onInvalid: p => invalid.push(p),
    })
    try {
      await sleep(300)
      writeFileSync(global, '{"numStartups":2}') // churn
      await sleep(500)
      expect(changes).toEqual([])

      writeFileSync(mcp, '{"mcpServers": {"a":') // broken
      await sleep(500)
      expect(changes).toEqual([])
      expect(invalid).toEqual([mcp])

      writeFileSync(mcp, '{"mcpServers":{"a":{"command":"x"}}}')
      await sleep(600)
      expect(changes).toEqual([mcp])
    } finally {
      await w.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
