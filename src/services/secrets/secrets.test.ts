import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SecretError,
  clearSecretCache,
  formatRef,
  parseRef,
  purgeSecret,
  refState,
  resolveRef,
  resolveRefAsync,
  storeSecret,
  type Ctx,
  type Runner,
} from './secrets.js'

type Call = { cmd: string; args: string[]; input?: string }

/** A runner backed by an in-memory `pass` store and keyring; records every call. */
function fakeCtx(extraEnv: Record<string, string> = {}) {
  const calls: Call[] = []
  const pass = new Map<string, string>()
  const ring = new Map<string, string>()
  const run: Runner = (cmd, args, input) => {
    calls.push({ cmd, args, input })
    if (cmd === 'pass') {
      if (args[0] === '--version') return { status: 0, stdout: 'v1', stderr: '' }
      if (args[0] === 'show') return pass.has(args[1]!) ? { status: 0, stdout: pass.get(args[1]!)! + '\nextra', stderr: '' } : { status: 1, stdout: '', stderr: 'not in the password store' }
      if (args[0] === 'insert') { pass.set(args[3]!, input!.trim()); return { status: 0, stdout: '', stderr: '' } }
      if (args[0] === 'rm') { pass.delete(args[2]!); return { status: 0, stdout: '', stderr: '' } }
    }
    if (cmd === 'secret-tool') {
      if (args[0] === '--version') return { status: 1, stdout: '', stderr: 'no such file' }
    }
    if (cmd === 'sh') return { status: 0, stdout: 'from-command\n', stderr: '' }
    return { status: 1, stdout: '', stderr: 'unexpected' }
  }
  const env = { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-sec-')), ...extraEnv }
  const ctx: Ctx = { env, run }
  return { ctx, calls, pass, ring, env }
}

describe('secret references', () => {
  beforeEach(() => clearSecretCache())

  test('parseRef splits gestor and ref and rejects unknown gestores or empty refs', () => {
    const r = parseRef('pass:apis/venice')
    expect(r.backend.id).toBe('pass')
    expect(r.ref).toBe('apis/venice')
    expect(() => parseRef('vault:x')).toThrow(SecretError)
    expect(() => parseRef('pass:')).toThrow(/Falta la referencia/)
    expect(() => parseRef('sin-gestor')).toThrow(SecretError)
    expect(formatRef('file', 'x')).toBe('file:x')
  })

  test('pass: get reads only the first line, caches, and passes the ref as one argv entry', () => {
    const { ctx, calls, pass } = fakeCtx()
    pass.set('apis/venice', 'secret-1')
    expect(resolveRef('pass:apis/venice', ctx)).toBe('secret-1')
    expect(resolveRef('pass:apis/venice', ctx)).toBe('secret-1')
    expect(calls.filter(c => c.args[0] === 'show').length).toBe(1)
  })

  test('resolveRefAsync gives the same value as resolveRef and shares its cache', async () => {
    const { ctx, calls, pass } = fakeCtx()
    pass.set('apis/venice', 'secret-1')
    expect(await resolveRefAsync('pass:apis/venice', ctx)).toBe('secret-1')
    expect(resolveRef('pass:apis/venice', ctx)).toBe('secret-1')
    expect(calls.filter(c => c.args[0] === 'show').length).toBe(1)
    await expect(resolveRefAsync('pass:apis/nada', ctx)).rejects.toThrow(/pass show apis\/nada falló/)
  })

  test('pass: refs that could be options or escape the store are refused before running anything', () => {
    const { ctx, calls } = fakeCtx()
    for (const bad of ['pass:-x', 'pass:../etc/passwd', 'pass:/abs', 'pass:a b']) {
      expect(() => resolveRef(bad, ctx)).toThrow(SecretError)
    }
    expect(calls.length).toBe(0)
  })

  test('pass: a missing entry fails with the reason, never with the value', () => {
    const { ctx } = fakeCtx()
    expect(() => resolveRef('pass:apis/nada', ctx)).toThrow(/pass show apis\/nada falló: not in the password store/)
  })

  test('storeSecret writes through pass and resolves back; purge deletes it', () => {
    const { ctx, pass } = fakeCtx()
    const ref = storeSecret('pass', 'apis/x', 'v1', ctx)
    expect(ref).toBe('pass:apis/x')
    expect(pass.get('apis/x')).toBe('v1')
    expect(resolveRef(ref, ctx)).toBe('v1')
    expect(purgeSecret(ref, ctx)).toBe(true)
    expect(pass.has('apis/x')).toBe(false)
  })

  test('file gestor stores in secrets.json with mode 0600', () => {
    const { ctx, env } = fakeCtx()
    const ref = storeSecret('file', 'venice', 'k-file', ctx)
    expect(resolveRef(ref, ctx)).toBe('k-file')
    expect((statSync(join(env.CLAUDE_CONFIG_DIR, 'secrets.json')).mode & 0o777).toString(8)).toBe('600')
    expect(refState('file:venice', ctx).state).toBe('ok')
    purgeSecret(ref, ctx)
    expect(refState('file:venice', ctx).state).toBe('missing')
  })

  test('env gestor reads a variable and is read-only', () => {
    const { ctx } = fakeCtx({ VENICE_API_KEY: 'from-env' })
    expect(resolveRef('env:VENICE_API_KEY', ctx)).toBe('from-env')
    expect(() => resolveRef('env:NOPE', ctx)).toThrow(/NOPE no está definida/)
    expect(() => storeSecret('env', 'X', 'v', ctx)).toThrow(/no admite escribir/)
  })

  test('cmd gestor runs the declared command; an undeclared name is an error', () => {
    const { ctx, env } = fakeCtx()
    expect(() => resolveRef('cmd:op1', ctx)).toThrow(/no hay comando "op1"/)
    storeSecret('file', 'x', 'y', ctx) // creates secrets.json
    const path = join(env.CLAUDE_CONFIG_DIR, 'secrets.json')
    const data = JSON.parse(require('fs').readFileSync(path, 'utf8'))
    data.commands = { op1: { get: 'op read op://v/venice/credential' } }
    require('fs').writeFileSync(path, JSON.stringify(data))
    clearSecretCache()
    expect(resolveRef('cmd:op1', ctx)).toBe('from-command')
  })

  test('keyring reports itself unavailable when secret-tool is missing', () => {
    const { ctx } = fakeCtx()
    expect(refState('keyring:venice', ctx).state).toBe('unavailable')
    expect(() => storeSecret('keyring', 'venice', 'v', ctx)).toThrow(/no disponible/)
  })
})
