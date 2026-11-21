import { describe, expect, test } from 'bun:test'
import { SessionConfigTool } from './SessionConfigTool.js'

const perm = (input: { op: string; value?: string | boolean | number }) =>
  SessionConfigTool.checkPermissions(input, {} as never)

describe('SessionConfig checkPermissions', () => {
  test('leer y bajar modelo/effort no piden confirmación', async () => {
    for (const input of [{ op: 'get' }, { op: 'model', value: 'haiku' }, { op: 'effort', value: 'low' }, { op: 'thinking', value: 'off' }, { op: 'permissionMode', value: 'plan' }]) {
      expect((await perm(input)).behavior).toBe('allow')
    }
  })
  test('subir permisos y cambiar de perfil preguntan', async () => {
    for (const input of [{ op: 'permissionMode', value: 'acceptEdits' }, { op: 'permissionMode', value: 'bypassPermissions' }, { op: 'perfil', value: 'minimo' }]) {
      expect((await perm(input)).behavior).toBe('ask')
    }
  })
  test('voiceListen: apagar sin confirmar, encender pregunta', async () => {
    expect((await perm({ op: 'voiceListen', value: 'off' })).behavior).toBe('allow')
    expect((await perm({ op: 'voiceListen', value: 'false' })).behavior).toBe('allow')
    expect((await perm({ op: 'voiceListen', value: 'on' })).behavior).toBe('ask')
    expect((await perm({ op: 'voiceListen', value: '1' })).behavior).toBe('ask')
    // valor inválido: nada que confirmar, se rechaza en call()
    expect((await perm({ op: 'voiceListen', value: 'quizas' })).behavior).toBe('allow')
  })
  test('solo está activa con FNHARNESS_SESSION_CONFIG=1', () => {
    const prev = process.env.FNHARNESS_SESSION_CONFIG
    delete process.env.FNHARNESS_SESSION_CONFIG
    expect(SessionConfigTool.isEnabled()).toBe(false)
    process.env.FNHARNESS_SESSION_CONFIG = '1'
    expect(SessionConfigTool.isEnabled()).toBe(true)
    if (prev === undefined) delete process.env.FNHARNESS_SESSION_CONFIG
    else process.env.FNHARNESS_SESSION_CONFIG = prev
  })
})
