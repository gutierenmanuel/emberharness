import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import { createStore } from '../state/store.js'
import {
  applySessionConfig,
  buildConfirmRequestText,
  normalizeValue,
  readSessionConfig,
  requiresConfirmation,
  type SessionConfigDeps,
  type SessionConfigHost,
} from './sessionConfig.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fnh-sc-'))
  const prevCfg = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  const store = createStore(getDefaultAppState(), onChangeAppState)
  const host: SessionConfigHost = { getAppState: store.getState, setAppState: store.setState }
  const logPath = join(dir, 'peer-log', 'session-config.jsonl')
  const deps: SessionConfigDeps = { logPath, validateModel: async m => (m === 'malo' ? { valid: false, error: 'no existe' } : { valid: true }) }
  const restore = () => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevCfg
  }
  const log = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [])
  return { dir, host, deps, restore, log, store }
}

describe('allowlist', () => {
  test('rechaza cualquier clave que no sea de la lista', () => {
    for (const op of ['theme', 'env', 'permissions.defaultMode', 'cyberGate', 'perfilCyber', '']) {
      const r = normalizeValue(op, 'x')
      expect(r.ok).toBe(false)
    }
    expect(normalizeValue('model', 'sonnet').ok).toBe(true)
  })
  test('nada ciber entra por modelo ni por perfil', () => {
    expect(normalizeValue('perfil', 'cyber-lab').ok).toBe(false)
    expect(normalizeValue('perfil', 'ciber').ok).toBe(false)
    expect(normalizeValue('model', 'cyber-model').ok).toBe(false)
  })
  test('valores inválidos', () => {
    expect(normalizeValue('effort', 'enorme').ok).toBe(false)
    expect(normalizeValue('thinking', 'quizá').ok).toBe(false)
    expect(normalizeValue('permissionMode', 'root').ok).toBe(false)
    expect(normalizeValue('model', undefined).ok).toBe(false)
    expect(normalizeValue('thinking', 'off')).toEqual({ ok: true, value: false })
  })
  test('applySessionConfig rechaza una clave fuera de la allowlist sin tocar el estado', async () => {
    const s = setup()
    try {
      const before = s.store.getState()
      const r = await applySessionConfig({ op: 'theme', value: 'dark', origin: 'tool', confirmed: true }, s.host, s.deps)
      expect(r.ok).toBe(false)
      expect(s.store.getState()).toBe(before)
    } finally {
      s.restore()
    }
  })
})

describe('confirmación', () => {
  test('solo subir permisos y cambiar de perfil la piden', () => {
    expect(requiresConfirmation('perfil', 'minimo')).toBe(true)
    for (const m of ['acceptEdits', 'dontAsk', 'auto', 'bypassPermissions']) expect(requiresConfirmation('permissionMode', m)).toBe(true)
    for (const m of ['default', 'plan']) expect(requiresConfirmation('permissionMode', m)).toBe(false)
    expect(requiresConfirmation('model', 'haiku')).toBe(false)
    expect(requiresConfirmation('effort', 'low')).toBe(false)
    expect(requiresConfirmation('thinking', false)).toBe(false)
  })
  test('sin confirmar no se aplica y se pide confirmar; el log lo marca pendiente', async () => {
    const s = setup()
    try {
      const before = s.store.getState().toolPermissionContext.mode
      const r = await applySessionConfig({ op: 'permissionMode', value: 'acceptEdits', origin: 'socket', confirmed: false, from: 'uds:/x' }, s.host, s.deps)
      expect(r).toMatchObject({ ok: true, applied: false, needsConfirm: true, to: 'acceptEdits' })
      expect(s.store.getState().toolPermissionContext.mode).toBe(before)
      expect(s.log()[0]).toMatchObject({ op: 'permissionMode', a: 'acceptEdits', origen: 'socket', applied: false, pending: true })
      expect(buildConfirmRequestText(r, 'uds:/x')).toContain('NO se ha aplicado')
    } finally {
      s.restore()
    }
  })
  test('el perfil nunca se aplica sin confirmar', async () => {
    const s = setup()
    try {
      const r = await applySessionConfig({ op: 'perfil', value: 'minimo', origin: 'socket', confirmed: false }, s.host, s.deps)
      expect(r.needsConfirm).toBe(true)
      expect(r.applied).toBe(false)
    } finally {
      s.restore()
    }
  })
  test('confirmado, el modo se aplica', async () => {
    const s = setup()
    try {
      const r = await applySessionConfig({ op: 'permissionMode', value: 'acceptEdits', origin: 'tool', confirmed: true }, s.host, s.deps)
      expect(r.applied).toBe(true)
      expect(s.store.getState().toolPermissionContext.mode).toBe('acceptEdits')
      await applySessionConfig({ op: 'permissionMode', value: 'default', origin: 'tool', confirmed: false }, s.host, s.deps)
      expect(s.store.getState().toolPermissionContext.mode).toBe('default')
    } finally {
      s.restore()
    }
  })
})

describe('modelo solo de esta sesión', () => {
  test('cambia mainLoopModelForSession y NO persiste nada en ajustes', async () => {
    const s = setup()
    try {
      const r = await applySessionConfig({ op: 'model', value: 'haiku', origin: 'tool', confirmed: true }, s.host, s.deps)
      expect(r).toMatchObject({ ok: true, applied: true, to: 'haiku' })
      expect(s.store.getState().mainLoopModelForSession).toBe('haiku')
      expect(s.store.getState().mainLoopModel).not.toBe('haiku')
      expect(readSessionConfig(s.store.getState()).model).toBe('haiku')
      // Ningún settings.json de usuario con `model` en el directorio de config.
      const settings = join(s.dir, 'settings.json')
      if (existsSync(settings)) expect(JSON.parse(readFileSync(settings, 'utf8')).model).toBeUndefined()
      expect(s.log()[0]).toMatchObject({ op: 'model', a: 'haiku', origen: 'tool', applied: true })
      expect(typeof s.log()[0].pid).toBe('number')
    } finally {
      s.restore()
    }
  })
  test('un modelo que no valida no se aplica', async () => {
    const s = setup()
    try {
      const r = await applySessionConfig({ op: 'model', value: 'malo', origin: 'tool', confirmed: true }, s.host, s.deps)
      expect(r.ok).toBe(false)
      expect(s.store.getState().mainLoopModelForSession).toBeNull()
    } finally {
      s.restore()
    }
  })
  test('effort y thinking van a la sesión', async () => {
    const s = setup()
    try {
      await applySessionConfig({ op: 'effort', value: 'low', origin: 'tool', confirmed: false }, s.host, s.deps)
      expect(s.store.getState().effortValue).toBe('low')
      await applySessionConfig({ op: 'effort', value: 'auto', origin: 'tool', confirmed: false }, s.host, s.deps)
      expect(s.store.getState().effortValue).toBeUndefined()
      await applySessionConfig({ op: 'thinking', value: 'off', origin: 'tool', confirmed: false }, s.host, s.deps)
      expect(s.store.getState().thinkingEnabled).toBe(false)
    } finally {
      s.restore()
    }
  })
  test('sin host registrado devuelve error', async () => {
    const r = await applySessionConfig({ op: 'effort', value: 'low', origin: 'socket', confirmed: false }, null)
    expect(r.ok).toBe(false)
  })
})
