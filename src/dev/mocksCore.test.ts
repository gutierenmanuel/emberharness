import { describe, expect, test } from 'bun:test'
import { getPillLabel } from '../tasks/pillLabel.js'
import {
  buildFakeTasks,
  EMPTY_MOCKS,
  isMockTaskId,
  parseMocks,
  parseMocksText,
} from './mocksCore.js'

describe('parseMocks', () => {
  test('entrada no objeto => estado vacío', () => {
    expect(parseMocks(null)).toEqual(EMPTY_MOCKS)
    expect(parseMocks('x')).toEqual(EMPTY_MOCKS)
    expect(parseMocks([1])).toEqual(EMPTY_MOCKS)
  })

  test('acota rangos y redondea', () => {
    const m = parseMocks({
      shells: -3,
      monitors: 99,
      agents: 2.6,
      accounts: 50,
      models: 9999,
      contextPct: 140,
    })
    expect(m.shells).toBe(0)
    expect(m.monitors).toBe(20)
    expect(m.agents).toBe(3)
    expect(m.accounts).toBe(12)
    expect(m.models).toBe(500)
    expect(m.contextPct).toBe(100)
  })

  test('tipos erróneos caen al valor por defecto', () => {
    const m = parseMocks({ shells: 'dos', permissionMode: 'root', contextPct: 'x' })
    expect(m.shells).toBe(0)
    expect(m.permissionMode).toBeNull()
    expect(m.contextPct).toBeNull()
  })

  test('modo de permisos válido', () => {
    expect(parseMocks({ permissionMode: 'plan' }).permissionMode).toBe('plan')
    expect(parseMocks({ permissionMode: 'bypassPermissions' }).permissionMode).toBe(
      'bypassPermissions',
    )
  })

  test('spinner, notificación y error', () => {
    const m = parseMocks({
      spinner: { on: true, text: 'Pensando' },
      notification: 'hola',
      error: { text: 'boom', seq: 4 },
    })
    expect(m.spinner).toEqual({ on: true, text: 'Pensando' })
    expect(m.notification).toEqual({ text: 'hola', seq: 0 })
    expect(m.error).toEqual({ text: 'boom', seq: 4 })
    expect(parseMocks({ notification: '' }).notification).toBeNull()
    expect(parseMocks({ spinner: { on: 'yes' } }).spinner.on).toBe(false)
  })
})

describe('parseMocksText', () => {
  test('JSON roto => null (se conserva el estado previo)', () => {
    expect(parseMocksText('{"shells":')).toBeNull()
    expect(parseMocksText('')).toBeNull()
  })
  test('JSON válido', () => {
    expect(parseMocksText('{"agents":2}')?.agents).toBe(2)
  })
})

describe('buildFakeTasks', () => {
  test('cuenta cada familia y marca los ids como mock', () => {
    const t = buildFakeTasks({ shells: 2, monitors: 1, agents: 3 }, 1000)
    const all = Object.values(t)
    expect(all.length).toBe(6)
    expect(Object.keys(t).every(isMockTaskId)).toBe(true)
    expect(all.filter(x => x.type === 'local_agent').length).toBe(3)
    expect(
      all.filter(x => x.type === 'local_bash' && x.kind === 'monitor').length,
    ).toBe(1)
  })

  test('sin procesos reales', () => {
    const t = Object.values(buildFakeTasks({ shells: 1, monitors: 0, agents: 0 }, 1))
    const sh = t[0]!
    expect(sh.type === 'local_bash' && sh.shellCommand).toBeNull()
    expect(sh.status).toBe('running')
  })

  test('la pastilla del pie sale con el texto esperado', () => {
    const t = Object.values(buildFakeTasks({ shells: 2, monitors: 1, agents: 3 }, 1))
    expect(getPillLabel(t)).toBe('2 shells · 1 monitor · 3 agents')
    expect(
      getPillLabel(Object.values(buildFakeTasks({ shells: 1, monitors: 0, agents: 0 }, 1))),
    ).toBe('1 shell')
    expect(
      getPillLabel(Object.values(buildFakeTasks({ shells: 0, monitors: 0, agents: 2 }, 1))),
    ).toBe('2 local agents')
  })

  test('cero tareas => objeto vacío', () => {
    expect(buildFakeTasks({ shells: 0, monitors: 0, agents: 0 }, 1)).toEqual({})
  })
})

describe('contadores de la cabecera', () => {
  test('sin accounts/models el mock no pisa el valor real', () => {
    const m = parseMocks({ shells: 1 })
    expect(m.accounts).toBeNull()
    expect(m.models).toBeNull()
  })
})
