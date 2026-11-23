import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRestartArgs, launcherCanRestart, manualRestartCommand, writeRestartFile } from './perfilRestart.js'

describe('reinicio de perfil', () => {
  test('los argumentos conservan sesión, perfil, cuenta y modelo', () => {
    expect(buildRestartArgs({ sessionId: 's1', perfil: 'minimo', account: 'twil', model: 'm' })).toEqual([
      '--resume', 's1', '--perfil', 'minimo', '--account', 'twil', '--model', 'm',
    ])
    // En la cuenta claude el modelo no viaja como --model (el lanzador lo llevaría al entorno multimodelo).
    expect(buildRestartArgs({ sessionId: 's1', perfil: 'full', account: 'claude', model: 'opus' })).toEqual([
      '--resume', 's1', '--perfil', 'full', '--account', 'claude',
    ])
    expect(buildRestartArgs({ sessionId: 's1', perfil: 'full' })).toEqual(['--resume', 's1', '--perfil', 'full'])
  })
  test('sin lanzador no se puede reiniciar y no se escribe nada', () => {
    const env = { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-rs-')) }
    expect(launcherCanRestart(env)).toBe(false)
    expect(writeRestartFile(['--resume', 'x'], env)).toBeUndefined()
    expect(launcherCanRestart({ ...env, FNHARNESS_LAUNCHER_PID: '1', FNHARNESS_NO_RESTART: '1' })).toBe(false)
  })
  test('con lanzador escribe restart/<pid>.args con un argumento por línea', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-rs-'))
    const path = writeRestartFile(['--resume', 's 1', '--perfil', 'x'], { CLAUDE_CONFIG_DIR: dir, FNHARNESS_LAUNCHER_PID: '4242' })
    expect(path).toBe(join(dir, 'restart', '4242.args'))
    expect(readFileSync(path!, 'utf8')).toBe('--resume\ns 1\n--perfil\nx\n')
  })
  test('el comando manual cita lo que lleva espacios', () => {
    expect(manualRestartCommand(['--resume', 'a b', '--perfil', 'x'])).toBe('emberh --resume "a b" --perfil x')
  })
})
