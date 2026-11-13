import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePerfil } from './perfil.js'
import {
  applyPerfilEnv,
  bootPerfil,
  createPerfilFrom,
  getPerfil,
  getSimpleModeExtraTools,
  hasExplicitAccount,
  syncSimpleModeExtraTools,
  listPerfiles,
  loadPerfilState,
  perfilNameFromArgv,
  resolveInitialPerfil,
  savePerfilState,
} from './perfilStore.js'

type E = Record<string, string | undefined>
const sandbox = (): E => ({ CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-perfil-')) })
const put = (env: E, file: string, content: string) => {
  const dir = join(env.CLAUDE_CONFIG_DIR!, 'profiles')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content)
}

describe('listPerfiles', () => {
  test('la fábrica trae full, simple y minimo', () => {
    const l = listPerfiles(sandbox())
    expect(l.entries.map(e => e.perfil.name)).toEqual(['full', 'simple', 'minimo'])
    expect(l.problems).toEqual([])
    expect(l.warnings).toEqual([])
    const minimo = l.entries[2]!.perfil
    expect(minimo.tools).toEqual(['Read', 'Write', 'Edit', 'Glob'])
    expect(minimo.context.bare).toBe(true)
    expect(minimo.systemPrompt.text).toContain('llama SIEMPRE a la herramienta Write o Edit')
    expect(l.entries[1]!.perfil.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'])
  })
  test('el del usuario sustituye al de fábrica y añade los nuevos; los rotos se reportan', () => {
    const env = sandbox()
    put(env, 'simple.json', JSON.stringify({ description: 'mío', tools: ['Read'] }))
    put(env, 'otro.json', JSON.stringify({ systemPrompt: { mode: 'append', file: 'extra.md' } }))
    put(env, 'extra.md', '  texto del fichero \n')
    put(env, 'roto.json', '{no es json')
    put(env, 'malo.json', JSON.stringify({ systemPrompt: { mode: 'replace' } }))
    const l = listPerfiles(env)
    expect(l.entries.map(e => `${e.perfil.name}:${e.source}`)).toEqual(['full:fábrica', 'simple:usuario', 'minimo:fábrica', 'otro:usuario'])
    expect(getPerfil('simple', env)!.perfil.description).toBe('mío')
    expect(getPerfil('otro', env)!.perfil.systemPrompt.text).toBe('texto del fichero')
    expect(l.problems.map(p => p.split(':')[0]).sort()).toEqual(['malo.json', 'roto.json'])
  })
})

describe('estado y creación', () => {
  test('profiles.json se guarda con 0600 y se vuelve a leer', () => {
    const env = sandbox()
    expect(loadPerfilState(env)).toEqual({})
    savePerfilState({ active: 'minimo' }, env)
    expect(loadPerfilState(env)).toEqual({ active: 'minimo' })
    expect((statSync(join(env.CLAUDE_CONFIG_DIR!, 'profiles.json')).mode & 0o777).toString(8)).toBe('600')
  })
  test('createPerfilFrom escribe un JSON que se vuelve a parsear y no pisa uno existente', () => {
    const env = sandbox()
    const base = getPerfil('minimo', env)!.perfil
    const path = createPerfilFrom(base, 'copia', env)
    expect(path).toBe(join(env.CLAUDE_CONFIG_DIR!, 'profiles', 'copia.json'))
    const r = parsePerfil(JSON.parse(readFileSync(path, 'utf8')), 'copia')
    expect(r.ok && r.perfil.tools).toEqual(['Read', 'Write', 'Edit', 'Glob'])
    expect(() => createPerfilFrom(base, 'copia', env)).toThrow('Ya existe')
    expect(() => createPerfilFrom(base, '../x', env)).toThrow('no válido')
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR!, 'x.json'))).toBe(false)
  })
})

describe('resolveInitialPerfil', () => {
  test('--perfil > FNHARNESS_PROFILE > default > active > ninguno', () => {
    const env = sandbox()
    expect(resolveInitialPerfil(undefined, env)).toEqual({ kind: 'none' })
    savePerfilState({ active: 'simple' }, env)
    expect(resolveInitialPerfil(undefined, env)).toMatchObject({ kind: 'found', source: 'active' })
    savePerfilState({ active: 'simple', default: 'minimo' }, env)
    const d = resolveInitialPerfil(undefined, env)
    expect(d.kind === 'found' && d.perfil.name).toBe('minimo')
    const e = resolveInitialPerfil(undefined, { ...env, FNHARNESS_PROFILE: 'full' })
    expect(e.kind === 'found' && [e.perfil.name, e.source]).toEqual(['full', 'env'])
    const c = resolveInitialPerfil('simple', { ...env, FNHARNESS_PROFILE: 'full' })
    expect(c.kind === 'found' && [c.perfil.name, c.source]).toEqual(['simple', 'cli'])
  })
  test('un nombre explícito inexistente es error; uno recordado inexistente se salta', () => {
    const env = sandbox()
    expect(resolveInitialPerfil('nada', env).kind).toBe('error')
    expect(resolveInitialPerfil(undefined, { ...env, FNHARNESS_PROFILE: 'nada' }).kind).toBe('error')
    savePerfilState({ default: 'borrado', active: 'simple' }, env)
    expect(resolveInitialPerfil(undefined, env)).toMatchObject({ kind: 'found', source: 'active' })
  })
})

describe('perfilNameFromArgv', () => {
  test('acepta --perfil x y --perfil=x', () => {
    expect(perfilNameFromArgv(['a', '--perfil', 'minimo', 'b'])).toBe('minimo')
    expect(perfilNameFromArgv(['--perfil=simple'])).toBe('simple')
    expect(perfilNameFromArgv(['-p', 'hola'])).toBeUndefined()
  })
})

describe('applyPerfilEnv', () => {
  test('apaga lo que el perfil apaga y restaura el valor original al pasar a otro', () => {
    const env: E = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }
    const full = getPerfil('full', sandbox())!.perfil
    const simple = getPerfil('simple', sandbox())!.perfil
    applyPerfilEnv(simple, env)
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env.FNHARNESS_PERFIL_NO_HOOKS).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined()
    applyPerfilEnv(full, env)
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0')
    expect(env.FNHARNESS_PERFIL_NO_HOOKS).toBeUndefined()
  })
})

describe('herramientas extra del modo bare', () => {
  test('solo un perfil bare con lista las pide; cualquier otro las limpia', () => {
    const env = sandbox()
    syncSimpleModeExtraTools(getPerfil('minimo', env)!.perfil)
    expect([...getSimpleModeExtraTools()].sort()).toEqual(['Edit', 'Glob', 'Read', 'Write'])
    syncSimpleModeExtraTools(getPerfil('simple', env)!.perfil)
    expect(getSimpleModeExtraTools().size).toBe(0)
    syncSimpleModeExtraTools(undefined)
    expect(getSimpleModeExtraTools().size).toBe(0)
  })
})

describe('cuenta del perfil al arrancar (--account > perfil > predeterminada)', () => {
  const withCuenta = (extra: E = {}): E => {
    const env: E = { ...sandbox(), ...extra }
    put(env, 'conc.json', JSON.stringify({ account: 'zcode', model: 'glm-5.3' }))
    return env
  }

  test('sin cuenta en el entorno, la del perfil se aplica (y su modelo si no es claude)', () => {
    const env = withCuenta()
    expect(bootPerfil(['--perfil', 'conc'], env)).toBeUndefined()
    expect(env.CLAUDE_MULTIMODEL_ACCOUNT).toBe('zcode')
    expect(env.CLAUDE_MULTIMODEL_MODEL).toBe('glm-5.3')
  })

  test('--account explícito (marca del lanzador) gana al perfil, aunque coincida con FNHARNESS_ACCOUNT', () => {
    const env = withCuenta({ CLAUDE_MULTIMODEL_ACCOUNT: 'claude', FNHARNESS_ACCOUNT: 'claude', FNHARNESS_ACCOUNT_FLAG: '1' })
    bootPerfil(['--perfil', 'conc'], env)
    expect(env.CLAUDE_MULTIMODEL_ACCOUNT).toBe('claude')
  })

  test('una variable puesta a mano (sin FNHARNESS_ACCOUNT igual) también gana al perfil', () => {
    const env = withCuenta({ CLAUDE_MULTIMODEL_ACCOUNT: 'ollama' })
    bootPerfil(['--perfil', 'conc'], env)
    expect(env.CLAUDE_MULTIMODEL_ACCOUNT).toBe('ollama')
  })

  test('la cuenta heredada de una sesión fnharness padre no gana al perfil', () => {
    const env = withCuenta({ CLAUDE_MULTIMODEL_ACCOUNT: 'claude', FNHARNESS_ACCOUNT: 'claude' })
    bootPerfil(['--perfil', 'conc'], env)
    expect(env.CLAUDE_MULTIMODEL_ACCOUNT).toBe('zcode')
  })

  test('hasExplicitAccount', () => {
    expect(hasExplicitAccount({})).toBe(false)
    expect(hasExplicitAccount({ CLAUDE_MULTIMODEL_ACCOUNT: 'a', FNHARNESS_ACCOUNT: 'a' })).toBe(false)
    expect(hasExplicitAccount({ CLAUDE_MULTIMODEL_ACCOUNT: 'a', FNHARNESS_ACCOUNT: 'b' })).toBe(true)
    expect(hasExplicitAccount({ CLAUDE_MULTIMODEL_ACCOUNT: 'a', FNHARNESS_ACCOUNT: 'a', FNHARNESS_ACCOUNT_FLAG: '1' })).toBe(true)
  })
})
