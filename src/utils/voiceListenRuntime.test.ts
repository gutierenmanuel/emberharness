import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  acquireVoiceLock,
  buildVoiceCommand,
  createVoiceListener,
  defaultBackoff,
  glueVoiceIntoQueue,
  parseVoiceLine,
  splitCommand,
  voiceStatusJson,
} from './voiceListenRuntime.js'
import { unwrapVoiceText, voiceDisplayText, wrapVoiceText } from './voiceOrigin.js'
import { wrapCommandText } from './messages.js'
import { clearCommandQueue, getCommandQueue } from './messageQueueManager.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function script(body: string): string {
  const p = join(dir, 'fake.py')
  writeFileSync(p, body)
  return `python3 -u ${p}`
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout esperando condicion')
    await new Promise(r => setTimeout(r, 20))
  }
}

const SECRET = 'frase secreta de prueba 12345'

describe('parseVoiceLine', () => {
  test('eventos válidos y basura', () => {
    expect(parseVoiceLine('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseVoiceLine('{"type":"speech_start","mic":"omi","t0":1.5}')).toEqual({
      type: 'speech_start',
      mic: 'omi',
      t0: 1.5,
    })
    expect(parseVoiceLine('{"type":"utterance","text":"  hola  ","mic":"omi","fragments":3}')).toMatchObject({
      type: 'utterance',
      text: 'hola',
      mic: 'omi',
      fragments: 3,
    })
    expect(parseVoiceLine('no es json')).toBeNull()
    expect(parseVoiceLine('{roto')).toBeNull()
    expect(parseVoiceLine('{"type":"utterance","text":"   "}')).toBeNull()
    expect(parseVoiceLine('{"type":"utterance","text":5}')).toBeNull()
    expect(parseVoiceLine('{"type":"otro"}')).toBeNull()
    expect(parseVoiceLine('[1,2]')).toBeNull()
  })
  test('mic raro se normaliza', () => {
    expect(parseVoiceLine('{"type":"utterance","text":"x","mic":"a b/c"}')).toMatchObject({ mic: 'mic' })
  })
})

describe('comando y textos', () => {
  test('buildVoiceCommand: prompt normal, origen voice, sin isMeta', () => {
    const c = buildVoiceCommand('hola', 'omi') as QueuedCommand & { isMeta?: boolean }
    expect(c).toMatchObject({ mode: 'prompt', value: 'hola', priority: 'next', skipSlashCommands: true })
    expect(c.origin).toEqual({ kind: 'voice', mic: 'omi' })
    expect(c.isMeta).toBeUndefined()
  })
  test('wrapCommandText case voice y vuelta atrás para el transcript', () => {
    const w = wrapCommandText('abre el log', { kind: 'voice', mic: 'omi' } as never)
    expect(w).toContain('La persona dijo por voz mientras trabajabas:')
    expect(w).toContain('abre el log')
    expect(w).not.toContain('NOT from your user')
    expect(w).toBe(wrapVoiceText('abre el log'))
    expect(unwrapVoiceText(w)).toBe('abre el log')
    expect(voiceDisplayText(w, { kind: 'voice', mic: 'omi' })).toBe('🎙 yo(omi): abre el log')
    expect(voiceDisplayText('hola', { kind: 'voice', mic: 'omi' })).toBe('🎙 yo(omi): hola')
  })
  test('splitCommand y backoff', () => {
    expect(splitCommand('a  "b c" d')).toEqual(['a', 'b c', 'd'])
    expect([1, 2, 3, 10].map(defaultBackoff)).toEqual([1000, 2000, 4000, 30000])
  })
})

describe('lock', () => {
  test('segundo adquiere → null; lock obsoleto de PID muerto se recupera', () => {
    const p = join(dir, 'v.lock')
    const a = acquireVoiceLock(p)
    expect(a).not.toBeNull()
    expect(acquireVoiceLock(p)).toBeNull()
    a!.release()
    expect(existsSync(p)).toBe(false)
    writeFileSync(p, '999999999')
    const b = acquireVoiceLock(p)
    expect(b).not.toBeNull()
    expect(readFileSync(p, 'utf8')).toBe(String(process.pid))
    b!.release()
  })
})

describe('continuation', () => {
  test('glueVoiceIntoQueue pega a la ultima voz que sigue en cola y no toca lo demas', () => {
    const typed = { mode: 'prompt', value: 'teclado', priority: 'next' } as QueuedCommand
    const a = buildVoiceCommand('quiero que mires', 'omi')
    let queue: QueuedCommand[] = [typed, a]
    const q = { getAll: () => [...queue], remove: (cs: QueuedCommand[]) => (queue = queue.filter(c => !cs.includes(c))) }
    const g = glueVoiceIntoQueue(q, 'el panel', 'c920')
    expect(g?.value).toBe('quiero que mires el panel')
    expect((g?.origin as { mic: string }).mic).toBe('c920')
    expect(queue).toEqual([typed])
    expect(glueVoiceIntoQueue(q, 'otra', 'omi')).toBeNull() // no queda voz en cola
  })

  test('listener: varias frases seguidas sin continuation salen JUNTAS en un solo mensaje', async () => {
    clearCommandQueue()
    const cmd = script(`
import json, time
print(json.dumps({"type":"ready"}), flush=True)
for t in ("primera frase", "segunda frase", "tercera frase"):
    print(json.dumps({"type":"utterance","text":t,"mic":"omi"}), flush=True)
time.sleep(5)
`)
    const l = createVoiceListener({ cmd, lockPath: join(dir, 'g.lock'), log: () => {} })
    expect(l.start()).toEqual({ started: true })
    await until(() => l.status().utterances === 3)
    expect(getCommandQueue().map(c => c.value)).toEqual(['primera frase segunda frase tercera frase'])
    expect(l.status().glued).toBe(2)
    l.stop()
  })

  test('listener: la cola queda con un solo mensaje y si ya se consumio va aparte', async () => {
    clearCommandQueue()
    const cmd = script(`
import json, time
print(json.dumps({"type":"ready"}), flush=True)
print(json.dumps({"type":"utterance","text":"quiero que mires","mic":"omi"}), flush=True)
print(json.dumps({"type":"utterance","text":"el panel","mic":"omi","continuation":True}), flush=True)
time.sleep(0.6)
print(json.dumps({"type":"utterance","text":"y otra","mic":"omi","continuation":True}), flush=True)
time.sleep(5)
`)
    const l = createVoiceListener({ cmd, lockPath: join(dir, 'c.lock'), log: () => {} })
    expect(l.start()).toEqual({ started: true })
    await until(() => l.status().glued === 1)
    expect(getCommandQueue().map(c => c.value)).toEqual(['quiero que mires el panel'])
    clearCommandQueue() // el modelo ya la tomo
    await until(() => getCommandQueue().length === 1)
    expect(getCommandQueue().map(c => c.value)).toEqual(['y otra'])
    expect(l.status().glued).toBe(1)
    l.stop()
  })
})

describe('enfoque de voz', () => {
  test('parseVoiceLine acepta focus y routed sin texto, y limpia la etiqueta', () => {
    expect(parseVoiceLine('{"type":"focus","target":"session:12","label":"oso naranja"}')).toEqual({
      type: 'focus',
      target: 'session:12',
      label: 'oso naranja',
    })
    expect(parseVoiceLine('{"type":"routed","target":"page:calibrar","label":"cal\\u001bibración"}')).toEqual({
      type: 'routed',
      target: 'page:calibrar',
      label: 'calibración',
    })
    expect(parseVoiceLine('{"type":"focus","label":"x"}')).toBeNull()
  })

  test('routed no llega a la cola y focus va al estado y al json de la statusline', async () => {
    clearCommandQueue()
    const cmd = script(`
import json
print(json.dumps({"type":"ready"}), flush=True)
print(json.dumps({"type":"focus","target":"self","label":""}), flush=True)
print(json.dumps({"type":"speech_start","mic":"omi"}), flush=True)
print(json.dumps({"type":"routed","target":"session:42","label":"oso naranja"}), flush=True)
print(json.dumps({"type":"utterance","text":"fin","mic":"omi"}), flush=True)
import time; time.sleep(5)
`)
    const l = createVoiceListener({ cmd, lockPath: join(dir, 'f.lock'), log: () => {} })
    expect(l.start()).toEqual({ started: true })
    await until(() => getCommandQueue().length >= 1)
    expect(getCommandQueue().map(c => c.value)).toEqual(['fin'])
    expect(l.status()).toMatchObject({ routed: 1, focus: { target: 'session:42', label: 'oso naranja' } })
    expect(voiceStatusJson(l.status()).focus).toEqual({ target: 'session:42', label: 'oso naranja' })
    l.stop()
  })
})

describe('listener con hijo falso', () => {
  test('utterance llega a la cola con origin voice, sin isMeta, y speech_start al callback; sin texto en logs', async () => {
    clearCommandQueue()
    const logs: string[] = []
    const speech: string[] = []
    const cmd = script(`
import sys, json
print('basura que no es json', flush=True)
print(json.dumps({"type":"ready"}), flush=True)
print(json.dumps({"type":"speech_start","mic":"omi","t0":1}), flush=True)
print(json.dumps({"type":"utterance","text":"${SECRET}","mic":"omi","t0":1,"t1":2,"fragments":2}), flush=True)
for line in sys.stdin:
    print(json.dumps({"type":"utterance","text":"eco "+json.loads(line)["spoken"],"mic":"omi"}), flush=True)
`)
    const l = createVoiceListener({
      cmd,
      lockPath: join(dir, 'v.lock'),
      log: m => logs.push(m),
      onSpeechStart: e => speech.push(e.mic),
    })
    expect(l.start()).toEqual({ started: true })
    await until(() => getCommandQueue().length >= 1)
    const q = getCommandQueue()[0] as QueuedCommand & { isMeta?: boolean }
    expect(q.value).toBe(SECRET)
    expect(q.origin).toEqual({ kind: 'voice', mic: 'omi' })
    expect(q.isMeta).toBeUndefined()
    expect(q.mode).toBe('prompt')
    expect(speech).toEqual(['omi'])
    expect(l.status()).toMatchObject({ running: true, ready: true, utterances: 1, lockHeld: true })
    // anti-eco por stdin
    expect(l.noteSpoken('hola mundo')).toBe(true)
    await until(() => l.status().utterances >= 2)
    expect(getCommandQueue().map(c => c.value)).toEqual([`${SECRET} eco hola mundo`]) // el modelo aun no la toma: se agrupa
    l.stop()
    expect(l.status().running).toBe(false)
    expect(existsSync(join(dir, 'v.lock'))).toBe(false)
    const all = logs.join('\n')
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain('hola mundo')
    expect(all).toContain('frase #1')
    clearCommandQueue()
  })

  test('si el hijo muere, reintenta', async () => {
    clearCommandQueue()
    const counter = join(dir, 'n')
    const cmd = script(`
import json, os
p = ${JSON.stringify(counter)}
n = int(open(p).read()) if os.path.exists(p) else 0
open(p, 'w').write(str(n + 1))
print(json.dumps({"type":"utterance","text":"arranque " + str(n + 1),"mic":"omi"}), flush=True)
`)
    const l = createVoiceListener({ cmd, lockPath: join(dir, 'v.lock'), backoff: () => 30, log: () => {} })
    l.start()
    await until(() => l.status().utterances >= 3)
    expect(l.status().restarts).toBeGreaterThanOrEqual(2)
    expect(getCommandQueue().map(c => c.value)).toEqual(['arranque 1 arranque 2 arranque 3'])
    l.stop()
    clearCommandQueue()
  })

  test('comando inexistente no tumba: reintenta con backoff', async () => {
    const l = createVoiceListener({
      cmd: '/no/existe/voz',
      lockPath: join(dir, 'v.lock'),
      backoff: () => 20,
      log: () => {},
    })
    l.start()
    await until(() => l.status().restarts >= 2)
    l.stop()
  })

  test('segunda instancia con el lock tomado no arranca', () => {
    const lock = join(dir, 'v.lock')
    const a = createVoiceListener({ cmd: 'sleep 30', lockPath: lock, log: () => {} })
    const b = createVoiceListener({ cmd: 'sleep 30', lockPath: lock, log: () => {} })
    expect(a.start()).toEqual({ started: true })
    expect(b.start()).toEqual({ started: false, reason: 'locked' })
    expect(b.status().running).toBe(false)
    a.stop()
    expect(b.start()).toEqual({ started: true })
    b.stop()
  })
})
