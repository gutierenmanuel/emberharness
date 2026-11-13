import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppStateStore.js'
import { parsePerfilArgs } from '../../utils/perfil.js'
import { getPerfil, loadPerfilState } from '../../utils/perfilStore.js'
import { applyPerfil, createPerfilFromSession, describePerfil, sessionBaseline } from './actions.js'

type E = Record<string, string | undefined>
const sandbox = (): E => ({ CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-perfil-cmd-')) })

/** Estado mínimo con setAppState real sobre un objeto. */
function fakeState(initial: Partial<AppState> = {}) {
  let state = { contextProfile: { mcp: 'full', skill: 'full', tools: 'full' }, ...initial } as AppState
  return {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
    get: () => state,
  }
}

const saved: E = {}
const touched = ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'FNHARNESS_PERFIL_NO_HOOKS']
for (const k of touched) saved[k] = process.env[k]
afterEach(() => {
  // applyPerfil fija variables de proceso (memoria, hooks): se restauran entre tests.
  for (const k of touched) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('applyPerfil', () => {
  test('en caliente: cambia scope y estado perfil, recuerda el activo y no reinicia', async () => {
    const env = sandbox()
    const s = fakeState()
    const r = await applyPerfil('simple', { ...s, env })
    expect(r.kind).toBe('applied')
    expect(s.get().perfil).toMatchObject({ name: 'simple', modified: false })
    expect(s.get().contextProfile).toEqual({
      mcp: 'none',
      skill: 'full',
      tools: 'simple',
      toolNames: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    })
    expect(loadPerfilState(env).active).toBe('simple')
    expect(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(process.env.FNHARNESS_PERFIL_NO_HOOKS).toBe('1')
    // Volver a full restaura el entorno: hooks apagados → encendidos SÍ reinicia (aviso, sin tocar la sesión).
    const back = await applyPerfil('full', { ...s, env })
    expect(back.kind).toBe('restart')
    expect(s.get().perfil?.name).toBe('simple')
  })
  test('reinicia cuando el perfil activa bare, sin tocar la sesión', async () => {
    const env = sandbox()
    const s = fakeState()
    const r = await applyPerfil('minimo', { ...s, env })
    expect(r.kind === 'restart' && r.reasons).toEqual(['activa el modo bare'])
    expect(s.get().perfil).toBeUndefined()
    expect(loadPerfilState(env).active).toBe('minimo')
  })
  test('una sesión ya bare cambia a otro perfil bare en caliente y sale de bare reiniciando', async () => {
    const env = { ...sandbox(), CLAUDE_CODE_SIMPLE: '1' }
    const s = fakeState()
    const r = await applyPerfil('full', { ...s, env })
    expect(r.kind).toBe('restart')
  })
  test('perfil desconocido', async () => {
    const s = fakeState()
    const r = await applyPerfil('nada', { ...s, env: sandbox() })
    expect(r.kind === 'error' && r.message).toContain('Disponibles: full, simple, minimo')
  })
  test('con cuenta en el perfil cambia de cuenta antes de aplicar el scope', async () => {
    const env = sandbox()
    writeUserPerfil(env, 'conctx', { account: 'twil', model: 'm1', tools: ['Read'] })
    const s = fakeState()
    const calls: Array<[string, string | undefined]> = []
    const r = await applyPerfil('conctx', {
      ...s,
      env,
      switchAccount: async (id, model) => {
        calls.push([id, model])
        return { message: `Cuenta activa: ${id}`, model: 'm1' }
      },
    })
    expect(calls).toEqual([['twil', 'm1']])
    expect(r.kind === 'applied' && r.message).toContain('Cuenta activa: twil')
    expect(s.get().mainLoopModel).toBe('m1')
    expect(s.get().contextProfile?.toolNames).toEqual(['Read'])
  })
})

function writeUserPerfil(env: E, name: string, body: object) {
  const dir = join(env.CLAUDE_CONFIG_DIR!, 'profiles')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(body))
}

describe('createPerfilFromSession', () => {
  test('escribe el JSON de la sesión actual y no pisa uno existente', () => {
    const env = sandbox()
    const base = getPerfil('minimo', env)!.perfil
    const state = {
      perfil: { name: 'minimo', def: base, modified: true },
      contextProfile: { mcp: 'none', skill: 'none', tools: 'simple', toolNames: ['Read', 'Write'] },
    } as AppState
    const r = createPerfilFromSession('mio', state, env)
    expect(r.ok).toBe(true)
    const path = join(env.CLAUDE_CONFIG_DIR!, 'profiles', 'mio.json')
    expect(r.ok && r.path).toBe(path)
    expect(existsSync(path)).toBe(true)
    const json = JSON.parse(readFileSync(path, 'utf8'))
    expect(json.tools).toEqual(['Read', 'Write'])
    expect(json.context).toMatchObject({ bare: true, mcp: false, skills: false })
    expect(createPerfilFromSession('mio', state, env).ok).toBe(false)
  })
  test('sin perfil activo parte del scope y de valores por defecto', () => {
    const env = sandbox()
    const r = createPerfilFromSession('x', { contextProfile: { mcp: 'full', skill: 'full', tools: 'full' } } as AppState, env)
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR!, 'profiles', 'x.json'), 'utf8')).tools).toBe('default')
  })
})

describe('helpers', () => {
  test('parsePerfilArgs de las tres formas', () => {
    expect(parsePerfilArgs('').kind).toBe('list')
    expect(parsePerfilArgs('simple').kind).toBe('use')
    expect(parsePerfilArgs('nuevo mio').kind).toBe('new')
  })
  test('sessionBaseline refleja bare por entorno', () => {
    expect(sessionBaseline(undefined, {}).context.bare).toBe(false)
    expect(sessionBaseline(undefined, { CLAUDE_CODE_SIMPLE: '1' }).context).toMatchObject({ bare: true, hooks: false })
  })
  test('describePerfil resume herramientas, prompt y lo apagado', () => {
    const minimo = getPerfil('minimo', sandbox())!.perfil
    const d = describePerfil(minimo)
    expect(d).toContain('4 tools (Read,Write,Edit,Glob)')
    expect(d).toContain('prompt propio')
    expect(d).toContain('bare')
    expect(d).toContain('sin CLAUDE.md, memoria, hooks, skills, MCP')
  })
})
