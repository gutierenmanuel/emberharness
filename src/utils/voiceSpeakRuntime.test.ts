import { voiceListenActive } from './voiceListenRuntime.js'
import { describe, expect, test } from 'bun:test'
import {
  MAX_SPOKEN_CHARS,
  assistantTextBlocks,
  createProcessQueue,
  createVoiceSpeaker,
  newSpokenStream,
  pickSpokenText,
  takeSpokenChunks,
  type SayOptions,
  type SpeechQueue,
} from './voiceSpeakRuntime.js'

function fakes(enabled = true) {
  const said: string[] = []
  const opts: SayOptions[] = []
  const noted: string[] = []
  let cancels = 0
  const queue: SpeechQueue = {
    say: (t, o) => {
      said.push(t)
      opts.push(o ?? {})
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
  return { said, opts, noted, speaker, cancels: () => cancels }
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

/** Feeds `text` in pieces of `step` characters and returns every chunk, in order. */
function streamChunks(text: string, step = 3): string[] {
  const st = newSpokenStream()
  const out: string[] = []
  for (let i = 0; i < text.length; i += step) {
    st.raw += text.slice(i, i + step)
    out.push(...takeSpokenChunks(st, false))
  }
  out.push(...takeSpokenChunks(st, true))
  return out
}

describe('takeSpokenChunks', () => {
  test('primer trozo: frase cerrada, o pausa natural solo con 8 palabras o más; luego frase a frase', () => {
    expect(streamChunks('Vale, voy a revisar el registro ahora, y te digo qué pasa. Después lo arreglo.')).toEqual([
      'Vale, voy a revisar el registro ahora, y te digo qué pasa.',
      'Después lo arreglo.',
    ])
    expect(streamChunks('Voy a revisar el registro de la cola ahora, y luego te digo qué pasa.')).toEqual([
      'Voy a revisar el registro de la cola ahora,',
      'y luego te digo qué pasa.',
    ])
  })
  test('una frase cerrada corta sale sola aunque tenga menos de 4 palabras', () => {
    expect(streamChunks('Listo. Ya funciona el login con enlace mágico.')).toEqual([
      'Listo.',
      'Ya funciona el login con enlace mágico.',
    ])
  })
  test('corta antes de una conjunción sin partir palabras', () => {
    expect(streamChunks('He mirado los tres ficheros del log de ayer pero no veo el error todavía')).toEqual([
      'He mirado los tres ficheros del log de ayer',
      'pero no veo el error todavía',
    ])
  })
  test('nunca corta números ni abreviaturas', () => {
    const out = streamChunks('Tengo 1, 2 y 3 copias de la versión 2.5 del informe, p. ej. la de ayer.', 2)
    expect(out.join(' ')).toContain('1, 2 y 3')
    expect(out.join(' ')).toContain('2.5')
    expect(out.some(c => c === 'p.' || c.endsWith(' p.'))).toBe(false)
  })
  test('no corta dentro de código en línea; lo quita al hablar', () => {
    const out = streamChunks('Ejecuta el comando `ls, -la; pwd` en la carpeta y luego me dices, ¿vale?')
    expect(out.join(' ')).not.toContain('ls')
    expect(out.join(' ')).not.toContain('`')
  })
  test('solo el primer párrafo; código y tablas no se hablan', () => {
    expect(streamChunks('Hecho, ya está todo en marcha.\n\nDetalle escrito que no se dice.')).toEqual([
      'Hecho, ya está todo en marcha.',
    ])
    expect(streamChunks('```\nls -la\n```')).toEqual([])
    expect(streamChunks('| a | b |\n|---|---|')).toEqual([])
  })
  test('el total no pasa de MAX_SPOKEN_CHARS', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Frase número ${i} con algo de texto.`).join(' ')
    const out = streamChunks(long, 7)
    expect(out.reduce((n, c) => n + c.length + 1, 0)).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 1)
    expect(out.length).toBeGreaterThan(1)
  })
  test('mismo resultado que pickSpokenText salvo los cortes', () => {
    const text = 'Vale, lo miro ahora mismo y te digo. El fallo está en la cola.\n\nResto.'
    expect(streamChunks(text, 5).join(' ')).toBe(pickSpokenText(text)!)
  })
})

describe('createVoiceSpeaker streaming', () => {
  test('habla mientras llega el texto, como un solo flujo, y no repite al cerrarse la entrada', async () => {
    const f = fakes()
    const text = 'Vale, voy a mirar el registro ahora mismo. Ya te cuento.'
    let early = 0
    for (let i = 0; i < text.length; i += 4) early += f.speaker.onDelta('msg_1', 0, text.slice(i, i + 4))
    expect(early).toBeGreaterThan(0) // algo sonó antes de terminar el bloque
    f.speaker.onBlockEnd('msg_1', 0)
    expect(f.speaker.onEntry({ ...entry(text), message: { id: 'msg_1', content: [{ type: 'text', text }] } })).toBe(0)
    await flush()
    expect(f.said.filter(Boolean).join(' ')).toBe(text)
    expect(new Set(f.opts.map(o => o.stream))).toEqual(new Set(['msg_1:0']))
    expect(f.opts.at(-1)?.fin).toBe(true)
    expect(f.noted).toEqual(f.said.filter(Boolean))
  })
  test('cierra el flujo con fin vacío cuando el último trozo ya había salido', async () => {
    const f = fakes()
    f.speaker.onDelta('m', 0, 'Hecho del todo. ')
    f.speaker.onBlockEnd('m', 0)
    await flush()
    expect(f.said).toEqual(['Hecho del todo.', ''])
    expect(f.opts.at(-1)).toEqual({ stream: 'm:0', fin: true })
    expect(f.noted).toEqual(['Hecho del todo.'])
  })
  test('barge-in corta el resto del bloque en streaming', async () => {
    const f = fakes()
    f.speaker.onDelta('m', 0, 'Primera frase dicha. ')
    f.speaker.bargeIn()
    f.speaker.onDelta('m', 0, 'Segunda frase que ya no suena. ')
    f.speaker.onBlockEnd('m', 0)
    await flush()
    expect(f.said).toEqual(['Primera frase dicha.'])
    expect(f.cancels()).toBe(1)
  })
  test('sin el flag no habla en streaming', () => {
    const f = fakes(false)
    expect(f.speaker.onDelta('m', 0, 'Hola, esto es una prueba. ')).toBe(0)
    expect(f.speaker.onBlockEnd('m', 0)).toBe(0)
    expect(f.said).toEqual([])
  })
  test('una entrada que no vino en streaming se sigue hablando (fallback)', async () => {
    const f = fakes()
    expect(f.speaker.onEntry({ ...entry('Hola.'), message: { id: 'otro', content: [{ type: 'text', text: 'Hola.' }] } })).toBe(1)
    await flush()
    expect(f.said).toEqual(['Hola.'])
  })
})

describe('createProcessQueue streaming', () => {
  test('pasa --stream y --fin a enqueue_speech', async () => {
    const calls: string[][] = []
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      const handlers: Record<string, (c?: number) => void> = {}
      queueMicrotask(() => handlers.exit?.(0))
      return { on: (ev: string, h: (c?: number) => void) => (handlers[ev] = h), unref() {} }
    }) as never
    const q = createProcessQueue(spawnFn)
    await q.say('Hola', { stream: 'm:0' })
    await q.say('', { stream: 'm:0', fin: true })
    const flat = calls.map(c => c.join(' '))
    expect(flat.some(c => c.endsWith('--prioridad respuesta --stream m:0 -- Hola'))).toBe(true)
    expect(flat.some(c => c.includes('--stream m:0 --fin --'))).toBe(true)
  })
})

describe('gate de la salida hablada', () => {
  test('una variable FNHARNESS_VOICE_LISTEN heredada sin listener propio no activa el habla', () => {
    const prev = process.env.FNHARNESS_VOICE_LISTEN
    process.env.FNHARNESS_VOICE_LISTEN = '1'
    try {
      expect(voiceListenActive()).toBe(false)
      const spoken: string[] = []
      // Sin `enabled` explícito, el locutor usa voiceListenActive (no la variable de entorno).
      const sp = createVoiceSpeaker({
        queue: { say: t => void spoken.push(t), cancel: () => {} },
        noteSpoken: () => true,
        log: () => {},
      })
      sp.onEntry({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hola mundo.' }] } })
      sp.onDelta('m2', 0, 'Hola de nuevo.\n\n')
      sp.onBlockEnd('m2', 0)
      expect(spoken).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.FNHARNESS_VOICE_LISTEN
      else process.env.FNHARNESS_VOICE_LISTEN = prev
    }
  })
})
