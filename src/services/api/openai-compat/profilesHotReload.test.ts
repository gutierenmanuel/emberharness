import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyMultimodelEnv, getMultimodelProfile, resetActiveProfileForTesting } from './profiles.js'
import { resetProvidersForTesting } from '../../config/providers.js'

const KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_MULTIMODEL_PROVIDER', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_MODEL', 'ANTHROPIC_MODEL', 'FNHARNESS_ACCOUNT']
const saved: Record<string, string | undefined> = {}
let dir: string
let clock = 1_000_000

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  dir = mkdtempSync(join(tmpdir(), 'fnh-hot-prof-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetActiveProfileForTesting()
  resetProvidersForTesting()
  spyOn(Date, 'now').mockImplementation(() => clock)
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetActiveProfileForTesting()
  resetProvidersForTesting()
})

const write = (name: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify(body))

describe('hot reload del perfil activo', () => {
  test('cambiar el modelo en accounts.json se aplica sin reiniciar', () => {
    write('accounts.json', { active: 'llamacpp', accounts: { llamacpp: { model: 'uno' } } })
    applyMultimodelEnv(process.env)
    expect(getMultimodelProfile()?.model).toBe('uno')
    expect(process.env.ANTHROPIC_MODEL).toBe('uno')

    write('accounts.json', { active: 'llamacpp', accounts: { llamacpp: { model: 'dos' } } })
    clock += 2000
    expect(getMultimodelProfile()?.model).toBe('dos')
    expect(process.env.ANTHROPIC_MODEL).toBe('dos')
  })

  test('un cambio en providers.json (ventana por modelo) también recarga', () => {
    write('accounts.json', { active: 'llamacpp', accounts: { llamacpp: { model: 'uno' } } })
    applyMultimodelEnv(process.env)
    expect(getMultimodelProfile()?.baseUrl).toBe('http://localhost:8082/v1')

    write('providers.json', { providers: { llamacpp: { baseUrl: 'http://localhost:9999/v1' } } })
    clock += 2000
    expect(getMultimodelProfile()?.baseUrl).toBe('http://localhost:9999/v1')
  })

  test('un accounts.json roto mantiene el perfil actual', () => {
    write('accounts.json', { active: 'llamacpp', accounts: { llamacpp: { model: 'uno' } } })
    applyMultimodelEnv(process.env)
    writeFileSync(join(dir, 'accounts.json'), '{roto')
    clock += 2000
    expect(getMultimodelProfile()?.model).toBe('uno')
  })

  test('el flag de lanzamiento --model sobrevive a la recarga', () => {
    write('accounts.json', { active: 'llamacpp', accounts: { llamacpp: { model: 'uno' } } })
    process.env.CLAUDE_MULTIMODEL_MODEL = 'forzado'
    applyMultimodelEnv(process.env)
    write('accounts.json', { active: 'llamacpp', accounts: { llamacpp: { model: 'dos', label: 'x' } } })
    clock += 2000
    expect(getMultimodelProfile()?.model).toBe('forzado')
  })
})
