import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LIVE_TTL_MS,
  SENT_TTL_MS,
  appendFragment,
  getVoiceLive,
  subscribeVoiceLive,
  voiceLineView,
  voiceLiveDiscard,
  voiceLiveExpire,
  voiceLiveFragment,
  voiceLiveNextExpiry,
  voiceLiveReady,
  voiceLiveReset,
  voiceLiveSent,
} from './voiceLiveState.js'
import { createVoiceListener, parseVoiceLine } from './voiceListenRuntime.js'
import { clearCommandQueue, getCommandQueue } from './messageQueueManager.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-live-'))
  voiceLiveReset()
})
afterEach(() => {
  voiceLiveReset()
  rmSync(dir, { recursive: true, force: true })
})

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout esperando condicion')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('parseVoiceLine fragment / discard', () => {
  test('fragment con block_id, sin texto no es evento, discard lleva el micro', () => {
    expect(parseVoiceLine('{"type":"fragment","text":" hola ","mic":"omi","t0":1,"t1":2,"block_id":"r7"}')).toEqual({
      type: 'fragment',
      text: 'hola',
      mic: 'omi',
      t0: 1,
      t1: 2,
      blockId: 'r7',
    })
    expect(parseVoiceLine('{"type":"fragment","text":"  ","mic":"omi"}')).toBeNull()
    expect(parseVoiceLine('{"type":"fragment","mic":"omi"}')).toBeNull()
    expect(parseVoiceLine('{"type":"discard","mic":"omi"}')).toEqual({ type: 'discard', mic: 'omi' })
  })
})

describe('estado en vivo', () => {
  test('apagado hasta ready; ignora fragmentos sin escucha', () => {
    voiceLiveFragment({ text: 'hola', mic: 'omi' })
    expect(getVoiceLive().phase).toBe('off')
    voiceLiveReady()
    expect(getVoiceLive().phase).toBe('listening')
  })

  test('los trozos se acumulan, un trozo repetido o con el mismo block_id no duplica', () => {
    voiceLiveReady()
    voiceLiveFragment({ text: 'hola que tal', mic: 'omi', blockId: 'a' }, 1000)
    voiceLiveFragment({ text: 'estas hoy', mic: 'omi', blockId: 'b' }, 1500)
    voiceLiveFragment({ text: 'estas hoy', mic: 'omi', blockId: 'b' }, 1600) // mismo id: ignorado
    voiceLiveFragment({ text: 'estas hoy', mic: 'omi' }, 1700) // mismo texto seguido: ignorado
    const s = getVoiceLive()
    expect(s.phase).toBe('dictating')
    expect(s.text).toBe('hola que tal estas hoy')
    expect(s.fragments).toBe(2)
  })

  test('la utterance sustituye al texto en vivo: no queda nada duplicado en pantalla', () => {
    voiceLiveReady()
    voiceLiveFragment({ text: 'hola', mic: 'omi' }, 1000)
    voiceLiveSent(4, 1100)
    const s = getVoiceLive()
    expect(s.phase).toBe('sent')
    expect(s.text).toBe('')
    expect(s.sentChars).toBe(4)
  })

  test('routed/discard retiran el texto y vuelven a escuchar', () => {
    voiceLiveReady()
    voiceLiveFragment({ text: 'enfoca a oso', mic: 'omi' })
    voiceLiveDiscard()
    expect(getVoiceLive()).toMatchObject({ phase: 'listening', text: '' })
  })

  test('caducidad: dictado sin cerrar y confirmación de enviado', () => {
    voiceLiveReady()
    voiceLiveFragment({ text: 'hola', mic: 'omi' }, 1000)
    expect(voiceLiveNextExpiry(1000)).toBe(LIVE_TTL_MS)
    expect(voiceLiveExpire(1000 + LIVE_TTL_MS - 1)).toBe(false)
    expect(voiceLiveExpire(1000 + LIVE_TTL_MS)).toBe(true)
    expect(getVoiceLive().phase).toBe('listening')
    voiceLiveSent(4, 5000)
    expect(voiceLiveNextExpiry(5000)).toBe(SENT_TTL_MS)
    expect(voiceLiveExpire(5000 + SENT_TTL_MS)).toBe(true)
    expect(getVoiceLive().phase).toBe('listening')
    expect(voiceLiveNextExpiry(9000)).toBeNull()
  })

  test('appendFragment', () => {
    expect(appendFragment('', ' a ')).toBe('a')
    expect(appendFragment('a', 'b')).toBe('a b')
    expect(appendFragment('a b', 'b')).toBe('a b')
    expect(appendFragment('a', '  ')).toBe('a')
  })
})

describe('qué se ve en pantalla', () => {
  test('escuchando / dictando / enviado / en cola, con la prioridad dictando > en cola > enviado', () => {
    expect(voiceLineView(getVoiceLive(), 0).kind).toBe('off')
    voiceLiveReady()
    expect(voiceLineView(getVoiceLive(), 0).kind).toBe('listening')
    voiceLiveFragment({ text: 'estoy hablando', mic: 'omi' })
    expect(voiceLineView(getVoiceLive(), 0)).toEqual({ kind: 'dictating', text: 'estoy hablando', waiting: 0 })
    expect(voiceLineView(getVoiceLive(), 1)).toEqual({ kind: 'dictating', text: 'estoy hablando', waiting: 1 })
    voiceLiveSent(14)
    expect(voiceLineView(getVoiceLive(), 0).kind).toBe('sent')
    expect(voiceLineView(getVoiceLive(), 1)).toEqual({ kind: 'queued', text: '', waiting: 1 })
  })
})

describe('con un hijo falso: retraso trozo -> pantalla y utterance -> cola', () => {
  test('mide y comprueba el orden de lo que se ve', async () => {
    clearCommandQueue()
    const log = join(dir, 'emitted.json')
    const py = join(dir, 'fake.py')
    // Emite 4 trozos espaciados 250 ms y cierra la frase 300 ms despues del ultimo; apunta la hora real de cada linea.
    writeFileSync(
      py,
      `
import json, sys, time
log = []
def emit(ev):
    print(json.dumps(ev), flush=True)
    log.append([ev["type"], int(time.time() * 1000)])
    open(${JSON.stringify(log)}, "w").write(json.dumps(log))
emit({"type": "ready"})
time.sleep(0.3)
parts = ["quiero que mires", "el panel de voz", "y que me digas", "si se ve en vivo"]
for i, p in enumerate(parts):
    emit({"type": "fragment", "text": p, "mic": "omi", "t0": i, "t1": i + 0.8, "block_id": "r%d" % i})
    time.sleep(0.25)
time.sleep(0.05)
emit({"type": "utterance", "text": " ".join(parts), "mic": "omi", "t0": 0, "t1": 3.8, "fragments": 4})
time.sleep(5)
`,
    )
    const seen: { phase: string; text: string; at: number }[] = []
    const unsub = subscribeVoiceLive(() => {
      const s = getVoiceLive()
      seen.push({ phase: s.phase, text: s.text, at: Date.now() })
    })
    const queuedAt: number[] = []
    const l = createVoiceListener({
      cmd: `python3 -u ${py}`,
      lockPath: join(dir, 'l.lock'),
      log: () => {},
      onUtterance: () => queuedAt.push(Date.now()),
    })
    expect(l.start()).toEqual({ started: true })
    await until(() => queuedAt.length === 1)
    unsub()
    const emitted = JSON.parse(readFileSync(log, 'utf8')) as [string, number][]
    const frags = emitted.filter(e => e[0] === 'fragment').map(e => e[1])
    const utt = emitted.find(e => e[0] === 'utterance')![1]

    const dictating = seen.filter(s => s.phase === 'dictating')
    expect(dictating.map(s => s.text)).toEqual([
      'quiero que mires',
      'quiero que mires el panel de voz',
      'quiero que mires el panel de voz y que me digas',
      'quiero que mires el panel de voz y que me digas si se ve en vivo',
    ])
    const lagFragment = dictating.map((s, i) => s.at - frags[i]!)
    const lagUtterance = queuedAt[0]! - utt
    const max = Math.max(...lagFragment)
    console.log(
      `[medida] retraso trozo->visible ms: ${lagFragment.join(', ')} (max ${max}); utterance->cola ms: ${lagUtterance}`,
    )
    expect(max).toBeLessThan(250)
    expect(lagUtterance).toBeLessThan(250)

    // La utterance es UN mensaje con la frase completa; en pantalla queda "enviado" y ya no hay texto en vivo.
    expect(getCommandQueue().map(c => c.value)).toEqual(['quiero que mires el panel de voz y que me digas si se ve en vivo'])
    expect(getVoiceLive()).toMatchObject({ phase: 'sent', text: '' })
    l.stop()
    expect(getVoiceLive().phase).toBe('off')
    clearCommandQueue()
  })
})
