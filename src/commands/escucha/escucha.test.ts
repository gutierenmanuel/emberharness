import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { call, describeStart, formatEstado, parseEscuchaArgs } from './escucha.js'
import { applySessionConfig, normalizeValue, requiresConfirmation, readSessionConfig, type SessionConfigHost } from '../../utils/sessionConfig.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { clearCommandQueue, getCommandQueue } from '../../utils/messageQueueManager.js'
import { stopVoiceListen, voiceListenStatus, voiceStatusJson, type VoiceStatus } from '../../utils/voiceListenRuntime.js'

const SECRET = 'texto secreto que no debe salir'
const base: VoiceStatus = { running: true, ready: true, pid: 1, restarts: 0, utterances: 0, lockHeld: true, speaking: false, lastMic: null, lastAt: null, focus: null, routed: 0, glued: 0 }

const saved = { cmd: process.env.FNHARNESS_VOICE_CMD, xdg: process.env.XDG_RUNTIME_DIR }
let dir: string | null = null
afterEach(() => {
  stopVoiceListen()
  clearCommandQueue()
  if (saved.cmd === undefined) delete process.env.FNHARNESS_VOICE_CMD
  else process.env.FNHARNESS_VOICE_CMD = saved.cmd
  if (saved.xdg === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = saved.xdg
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function fakeVoice(): void {
  dir = mkdtempSync(join(tmpdir(), 'escucha-'))
  process.env.XDG_RUNTIME_DIR = dir
  const script = join(dir, 'fake.py')
  writeFileSync(
    script,
    `import json, sys, time
print(json.dumps({"type":"ready"}), flush=True)
print(json.dumps({"type":"speech_start","mic":"omi"}), flush=True)
print(json.dumps({"type":"utterance","text":"${SECRET}","mic":"omi"}), flush=True)
time.sleep(30)
`,
  )
  process.env.FNHARNESS_VOICE_CMD = `python3 -u ${script}`
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('parseEscuchaArgs', () => {
  test('on, off, estado y vacío', () => {
    expect(parseEscuchaArgs('on')).toBe('on')
    expect(parseEscuchaArgs(' OFF ')).toBe('off')
    expect(parseEscuchaArgs('estado')).toBe('estado')
    expect(parseEscuchaArgs('')).toBe('estado')
    expect(parseEscuchaArgs('xyz')).toBeNull()
  })
})

describe('formatEstado / voiceStatusJson', () => {
  test('apagada, escuchando, hablando; la última frase es solo mic y hora', () => {
    expect(formatEstado({ ...base, running: false })).toBe('Escucha: apagada')
    expect(formatEstado(base)).toContain('escuchando')
    expect(formatEstado(base)).toContain('sin frases todavía')
    const at = new Date(2026, 10, 21, 9, 5, 7).getTime()
    const talking = formatEstado({ ...base, speaking: true, utterances: 2, lastMic: 'omi', lastAt: at })
    expect(talking).toContain('hablando')
    expect(talking).toContain('omi a las 09:05:07')
    expect(voiceStatusJson({ ...base, speaking: true, lastMic: 'omi', lastAt: at })).toEqual({ listening: true, speaking: true, last: { mic: 'omi', at }, focus: null })
    expect(voiceStatusJson({ ...base, running: false })).toEqual({ listening: false, speaking: false, last: null, focus: null })
    expect(voiceStatusJson({ ...base, ready: false }).listening).toBe(false)
  })
  test('describeStart cubre cada motivo', () => {
    expect(describeStart({ started: true })).toContain('encendida')
    expect(describeStart({ started: false, reason: 'locked' })).toContain('otra sesión')
  })
})

describe('/escucha con hijo falso', () => {
  test('on → estado (sin texto) → off', async () => {
    fakeVoice()
    const ctx = {} as never
    expect(((await call('on', ctx)) as { value: string }).value).toContain('encendida')
    await until(() => getCommandQueue().length >= 1 && voiceListenStatus().lastMic !== null)
    expect(getCommandQueue()[0]!.value).toBe(SECRET)
    const estado = ((await call('estado', ctx)) as { value: string }).value
    expect(estado).toContain('escuchando')
    expect(estado).toContain('omi a las')
    expect(estado).not.toContain(SECRET)
    expect(((await call('on', ctx)) as { value: string }).value).toContain('ya estaba')
    expect(((await call('off', ctx)) as { value: string }).value).toBe('Escucha apagada.')
    expect(voiceListenStatus().running).toBe(false)
    expect(((await call('estado', ctx)) as { value: string }).value).toBe('Escucha: apagada')
  })
})

describe('op voiceListen en SessionConfig', () => {
  const mkHost = (): SessionConfigHost => {
    let st = getDefaultAppState()
    return { getAppState: () => st, setAppState: f => void (st = f(st)) }
  }
  const deps = { logPath: '/dev/null/nope' } // el registro nunca rompe el cambio

  test('normaliza y exige confirmación solo para encender', () => {
    expect(normalizeValue('voiceListen', 'ON')).toEqual({ ok: true, value: 'on' })
    expect(normalizeValue('voiceListen', 'no').ok).toBe(false)
    expect(requiresConfirmation('voiceListen', 'on')).toBe(true)
    expect(requiresConfirmation('voiceListen', 'off')).toBe(false)
  })
  test('por el socket, encender sin confirmar no arranca; apagar sí se aplica', async () => {
    fakeVoice()
    const host = mkHost()
    const pending = await applySessionConfig({ op: 'voiceListen', value: 'on', origin: 'socket', confirmed: false }, host, deps)
    expect(pending).toMatchObject({ ok: true, applied: false, needsConfirm: true })
    expect(voiceListenStatus().running).toBe(false)
    const on = await applySessionConfig({ op: 'voiceListen', value: 'on', origin: 'tool', confirmed: true }, host, deps)
    expect(on).toMatchObject({ ok: true, applied: true, to: 'on' })
    expect(voiceListenStatus().running).toBe(true)
    expect(readSessionConfig(host.getAppState()).voiceListen).toBe('on')
    const off = await applySessionConfig({ op: 'voiceListen', value: 'off', origin: 'socket', confirmed: false }, host, deps)
    expect(off).toMatchObject({ ok: true, applied: true, needsConfirm: false, to: 'off' })
    expect(voiceListenStatus().running).toBe(false)
  })
})

describe('formatEstado con enfoque de voz', () => {
  test('muestra el destino si no es esta sesion', () => {
    expect(formatEstado({ ...base, focus: { target: 'session:9', label: 'oso naranja' }, routed: 2 })).toContain(
      'voz enfocada a oso naranja (enviadas: 2)',
    )
    expect(formatEstado({ ...base, focus: { target: 'self', label: '' } })).not.toContain('enfocada')
  })
})
