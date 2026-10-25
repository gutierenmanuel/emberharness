/** bin/fnharness --accounts / --set-default: pure shell paths that exit before starting the CLI. Needs jq. */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const LAUNCHER = resolve(import.meta.dir, '..', 'bin', 'fnharness')

function run(dir: string, ...args: string[]) {
  const p = Bun.spawnSync(['bash', LAUNCHER, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode }
}
const dirWith = (store?: object) => {
  const d = mkdtempSync(join(tmpdir(), 'fnh-launch-'))
  if (store) writeFileSync(join(d, 'accounts.json'), JSON.stringify(store))
  return d
}
const read = (d: string) => JSON.parse(readFileSync(join(d, 'accounts.json'), 'utf8'))

describe('bin/fnharness default account', () => {
  test('--accounts lists presets and saved accounts and says where the next launch comes from', () => {
    const d = dirWith({ active: 'llamacpp', accounts: { mine: { provider: 'custom' } } })
    const r = run(d, '--accounts')
    expect(r.out).toContain('llamacpp (última usada)')
    expect(r.out).toMatch(/^mine$/m)
    expect(r.out).toContain('Al abrir: llamacpp (última usada)')
  })

  test('--set-default writes default, keeps active, uses mode 0600 and --accounts shows it', () => {
    const d = dirWith({ active: 'llamacpp', accounts: {} })
    expect(run(d, '--set-default', 'qwen36').code).toBe(0)
    expect(read(d)).toMatchObject({ active: 'llamacpp', default: 'qwen36' })
    expect(statSync(join(d, 'accounts.json')).mode & 0o777).toBe(0o600)
    const r = run(d, '--accounts')
    expect(r.out).toContain('qwen36 (predeterminada)')
    expect(r.out).toContain('Al abrir: qwen36 (predeterminada)')
  })

  test('--set-default <cuenta> <modelo> stores the model; a fresh dir gets a file', () => {
    const d = dirWith()
    expect(run(d, '--set-default', 'ollama', 'qwen3:14b').code).toBe(0)
    expect(read(d)).toMatchObject({ default: 'ollama', accounts: { ollama: { model: 'qwen3:14b' } } })
  })

  test('unknown account is refused and nothing changes; last clears the default', () => {
    const d = dirWith({ default: 'qwen36', accounts: {} })
    const bad = run(d, '--set-default', 'nope')
    expect(bad.code).not.toBe(0)
    expect(bad.err).toContain('cuenta desconocida')
    expect(read(d).default).toBe('qwen36')
    expect(run(d, '--set-default', 'last').code).toBe(0)
    expect(read(d).default).toBeUndefined()
  })
})
