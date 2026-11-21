import { describe, expect, test } from 'bun:test'
import {
  MAX_SPOKEN_CHARS,
  assistantTextBlocks,
  createProcessQueue,
  createVoiceSpeaker,
  pickSpokenText,
  type SpeechQueue,
} from './voiceSpeakRuntime.js'

function fakes(enabled = true) {
  const said: string[] = []
  const noted: string[] = []
  let cancels = 0
  const queue: SpeechQueue = {
    say: t => {
      said.push(t)
    },
    cancel: () => {
      cancels += 1
    },
  }
  const speaker = createVoiceSpeaker({
    queue,
    noteSpoken: t => (noted.push(t), true),
    enabled: () => enabled,
    log: () => {},
  })
  return { said, noted, speaker, cancels: () => cancels }
}

const entry = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: Math.random().toString(36),
  message: { content: [{ type: 'text', text }] },
  ...extra,
})
const flush = () => new Promise(r => setTimeout(r, 5))

describe('pickSpokenText', () => {
  test('solo el primer parrafo', () => {
    expect(pickSpokenText('Listo, ya esta.\n\nDetalle largo\n\nMas detalle')).toBe('Listo, ya esta.')
  })
  test('no habla codigo ni tablas', () => {
    expect(pickSpokenText('```ts\nconst a = 1\n```\n\nTexto')).toBeNull()
    expect(pickSpokenText('| a | b |\n|---|---|\n| 1 | 2 |')).toBeNull()
  })
  test('quita codigo en linea, rutas y urls', () => {
    const t = pickSpokenText('Edite `foo()` en /home/user/fn_registry/apps/x/y.ts y vi https://a.com/b ya.')!
    expect(t).not.toContain('/home')
    expect(t).not.toContain('foo()')
    expect(t).not.toContain('https')
    expect(t).toContain('Edite')
  })
  test('recorta >240 en limite de frase', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Esta es la frase numero ${i}.`).join(' ')
    const t = pickSpokenText(long)!
    expect(t.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS)
    expect(t.endsWith('.')).toBe(true)
  })
  test('una frase gigante se corta por palabra', () => {
    const t = pickSpokenText('palabra '.repeat(100))!
    expect(t.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS)
  })
})

describe('assistantTextBlocks', () => {
  test('ignora sidechain, usuario y bloques no texto', () => {
    expect(assistantTextBlocks(entry('hola', { isSidechain: true }))).toEqual([])
    expect(assistantTextBlocks({ type: 'user', message: { content: 'hola' } })).toEqual([])
    expect(
      assistantTextBlocks({ type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'text', text: 'x' }] } }),
    ).toEqual(['x'])
  })
})

describe('createVoiceSpeaker', () => {
  test('habla el primer parrafo y llama a noteSpoken (anti-eco)', async () => {
    const f = fakes()
    expect(f.speaker.onEntry(entry('Hola, mira.\n\nDetalle escrito.'))).toBe(1)
    await flush()
    expect(f.said).toEqual(['Hola, mira.'])
    expect(f.noted).toEqual(['Hola, mira.'])
  })
  test('no habla codigo', async () => {
    const f = fakes()
    expect(f.speaker.onEntry(entry('```\nls\n```'))).toBe(0)
    await flush()
    expect(f.said).toEqual([])
    expect(f.noted).toEqual([])
  })
  test('sin el flag no habla nada', async () => {
    const f = fakes(false)
    expect(f.speaker.onEntry(entry('Hola.'))).toBe(0)
    f.speaker.bargeIn()
    await flush()
    expect(f.said).toEqual([])
    expect(f.cancels()).toBe(0)
  })
  test('misma entrada no se habla dos veces', async () => {
    const f = fakes()
    const e = entry('Hola.')
    f.speaker.onEntry(e)
    f.speaker.onEntry(e)
    await flush()
    expect(f.said).toEqual(['Hola.'])
  })
  test('barge-in cancela y descarta el anti-eco pendiente', async () => {
    const f = fakes()
    f.speaker.onEntry(entry('Hola.'))
    f.speaker.bargeIn()
    await flush()
    expect(f.cancels()).toBe(1)
    expect(f.noted).toEqual([])
  })
})

describe('createProcessQueue', () => {
  test('cola viva: encola con prioridad respuesta; cancel usa --cancel', async () => {
    const calls: string[][] = []
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      const handlers: Record<string, (c?: number) => void> = {}
      queueMicrotask(() => handlers.exit?.(0))
      return { on: (ev: string, h: (c?: number) => void) => (handlers[ev] = h), unref() {} }
    }) as never
    const q = createProcessQueue(spawnFn)
    await q.say('Hola -x')
    await q.cancel()
    const flat = calls.map(c => c.join(' '))
    expect(flat.some(c => c.includes('--status'))).toBe(true)
    expect(flat.some(c => c.includes('--prioridad respuesta -- Hola -x'))).toBe(true)
    expect(flat.at(-1)).toContain('--cancel')
  })
})
