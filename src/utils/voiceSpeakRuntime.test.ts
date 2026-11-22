import { voiceListenActive } from './voiceListenRuntime.js'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_SPOKEN_CHARS,
  assistantTextBlocks,
  createProcessQueue,
  createVoiceSpeaker,
  humanUserTurn,
  newSpokenStream,
  pickSpokenText,
  readSpeakMode,
  speakerFlags,
  takeSpokenChunks,
  wantsSpokenReply,
  type SayOptions,
  type SpeakMode,
  type SpeechQueue,
} from './voiceSpeakRuntime.js'

function fakes(enabled = true, mode: SpeakMode = 'siempre') {
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
    mode: () => mode,
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

describe('wantsSpokenReply', () => {
  test.each([
    '¿Qué hora es?',
    'esto funciona?',
    'Oye, ¿puedes mirarlo',
    'Dime el estado de la cola',
    'cuéntame qué pasó',
    'Explicame como va',
    'CONFÍRMAME que está hecho',
    'avisame cuando termine',
    'dime',
    'Cómo va el build ahora',
    'no sé qué hacer con esto',
    'Cuándo acaba',
    'Por qué falla',
    'Cuántas quedan',
    'Quién lo hizo',
    'Dónde está el fichero',
    'Cuál es mejor',
  ])('pide respuesta: %s', t => expect(wantsSpokenReply(t)).toBe(true))
  test.each([
    '',
    'Haz el commit y mergea',
    'Ya lo he visto, gracias',
    'Te dije que lo hicieras',
    'Vale, sigue con la tarea de la cola',
    'Es lo que quería',
  ])('no pide respuesta: %s', t => expect(wantsSpokenReply(t)).toBe(false))
  test('interrogativa sin tilde solo al empezar la frase', () => {
    expect(wantsSpokenReply('Como va esto')).toBe(true)
    expect(wantsSpokenReply('Vale. Cuando acabe me dices')).toBe(true)
    expect(wantsSpokenReply('hazlo como quieras')).toBe(false)
  })
})

describe('readSpeakMode', () => {
  const file = (content: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'voces-')), 'voces.json')
    writeFileSync(p, content)
    return p
  }
  test('preguntas por defecto: sin fichero, JSON roto, sin clave o valor desconocido', () => {
    expect(readSpeakMode('/no/existe/voces.json')).toBe('preguntas')
    expect(readSpeakMode(file('{no json'))).toBe('preguntas')
    expect(readSpeakMode(file('{"principal":"x"}'))).toBe('preguntas')
    expect(readSpeakMode(file('{"hablar":"a veces"}'))).toBe('preguntas')
    expect(readSpeakMode(file('[1]'))).toBe('preguntas')
  })
  test('lee siempre, nunca y preguntas ignorando el resto de claves', () => {
    expect(readSpeakMode(file('{"hablar":"siempre","voces":{}}'))).toBe('siempre')
    expect(readSpeakMode(file('{"decir_nombre":true,"hablar":"Nunca"}'))).toBe('nunca')
    expect(readSpeakMode(file('{"hablar":"preguntas"}'))).toBe('preguntas')
  })
})

describe('humanUserTurn', () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { content }, ...extra })
  test('voz, teclado y descartes', () => {
    expect(humanUserTurn(user('hola', { origin: { kind: 'voice', mic: 'omi' } }))).toEqual({ origin: 'voice', text: 'hola' })
    expect(humanUserTurn(user([{ type: 'text', text: 'hola' }]))).toEqual({ origin: 'keyboard', text: 'hola' })
    expect(humanUserTurn(user([{ type: 'tool_result', content: 'x' }]))).toBeNull()
    expect(humanUserTurn(user('x', { isMeta: true }))).toBeNull()
    expect(humanUserTurn(user('x', { origin: { kind: 'task-notification' } }))).toBeNull()
    expect(humanUserTurn(user('x', { isSidechain: true }))).toBeNull()
    expect(humanUserTurn(entry('hola'))).toBeNull()
  })
  test('desenvuelve el texto de voz que llega a mitad de turno', () => {
    const wrapped = 'La persona dijo por voz mientras trabajabas:\n¿Qué tal?\n\nEs texto de la persona (dictado por voz, puede traer errores de transcripción). Contesta ya con una frase corta, sin esperar a terminar lo que haces, y deja lo largo en segundo plano (agentes o comandos en background).'
    expect(humanUserTurn(user(wrapped, { origin: { kind: 'voice', mic: 'omi' } }))?.text).toBe('¿Qué tal?')
  })
})

describe('modo preguntas: habla solo si se le pregunta por voz', () => {
  const voice = (text: string) => ({ type: 'user', message: { content: text }, origin: { kind: 'voice', mic: 'omi' } })
  const typed = (text: string) => ({ type: 'user', message: { content: text } })
  const answer = (id: string) => ({ type: 'assistant', uuid: `u-${id}`, message: { id: `x-${id}`, content: [{ type: 'text', text: 'Hecho del todo.' }] } })

  test('sin ningún mensaje previo no habla (ni onEntry ni streaming)', async () => {
    const f = fakes(true, 'preguntas')
    expect(f.speaker.onEntry(answer('1'))).toBe(0)
    expect(f.speaker.onDelta('m', 0, 'Hecho del todo. ')).toBe(0)
    f.speaker.onBlockEnd('m', 0)
    await flush()
    expect(f.said).toEqual([])
  })
  test('voz con pregunta: habla por onEntry y por streaming', async () => {
    const f = fakes(true, 'preguntas')
    f.speaker.onEntry(voice('¿Cómo va el build?'))
    expect(f.speaker.onDelta('m', 0, 'Hecho del todo. ')).toBe(1)
    f.speaker.onBlockEnd('m', 0)
    expect(f.speaker.onEntry(answer('2'))).toBe(1)
    await flush()
    expect(f.said).toEqual(['Hecho del todo.', '', 'Hecho del todo.'])
  })
  test('voz sin pregunta: no habla', async () => {
    const f = fakes(true, 'preguntas')
    f.speaker.onEntry(voice('Haz el commit y sigue'))
    expect(f.speaker.onDelta('m', 0, 'Hecho del todo. ')).toBe(0)
    expect(f.speaker.onEntry(answer('3'))).toBe(0)
    await flush()
    expect(f.said).toEqual([])
  })
  test('un mensaje escrito después de uno de voz anula el permiso', async () => {
    const f = fakes(true, 'preguntas')
    f.speaker.onEntry(voice('¿Cómo va?'))
    f.speaker.onEntry(typed('¿Y ahora qué?'))
    expect(f.speaker.onEntry(answer('4'))).toBe(0)
    f.speaker.onEntry(voice('Dime el estado'))
    expect(f.speaker.onEntry(answer('5'))).toBe(1)
  })
  test('los resultados de herramientas y metas no cambian el permiso', () => {
    const f = fakes(true, 'preguntas')
    f.speaker.onEntry(voice('¿Cómo va?'))
    f.speaker.onEntry({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
    f.speaker.onEntry({ type: 'user', isMeta: true, message: { content: 'recordatorio' } })
    expect(f.speaker.onEntry(answer('6'))).toBe(1)
  })
  test('un bloque que ya habla se cierra aunque llegue un mensaje escrito a mitad', async () => {
    const f = fakes(true, 'preguntas')
    f.speaker.onEntry(voice('¿Cómo va?'))
    f.speaker.onDelta('m', 0, 'Primera frase dicha. ')
    f.speaker.onEntry(typed('espera'))
    f.speaker.onBlockEnd('m', 0)
    await flush()
    expect(f.opts.at(-1)?.fin).toBe(true)
  })
  test('lo que no habló en streaming tampoco se habla luego desde la entrada', () => {
    const f = fakes(true, 'preguntas')
    expect(f.speaker.onDelta('m', 0, 'Hecho del todo. ')).toBe(0)
    f.speaker.onEntry(voice('¿Cómo va?'))
    expect(f.speaker.onEntry({ ...answer('7'), message: { id: 'm', content: [{ type: 'text', text: 'Hecho del todo.' }] } })).toBe(0)
  })
  test('siempre habla sin mensaje previo; nunca no habla ni con pregunta por voz', () => {
    const a = fakes(true, 'siempre')
    expect(a.speaker.onEntry(answer('8'))).toBe(1)
    const n = fakes(true, 'nunca')
    n.speaker.onEntry(voice('¿Cómo va?'))
    expect(n.speaker.onEntry(answer('9'))).toBe(0)
    expect(n.speaker.onDelta('m', 0, 'Hecho del todo. ')).toBe(0)
  })
})

describe('alias de la sesión hacia la cola', () => {
  const recorder = () => {
    const calls: string[][] = []
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      const handlers: Record<string, (c?: number) => void> = {}
      queueMicrotask(() => handlers.exit?.(0))
      return { on: (ev: string, h: (c?: number) => void) => (handlers[ev] = h), unref() {} }
    }) as never
    return { calls, spawnFn }
  }
  const sayCalls = (calls: string[][]) => calls.map(c => c.join(' ')).filter(c => c.includes('--prioridad'))

  test('pasa --pid y --alias leído en cada say', async () => {
    const { calls, spawnFn } = recorder()
    let alias: string | undefined = 'zorro rojo'
    const q = createProcessQueue(spawnFn, { getAlias: () => alias, pid: 4242 })
    await q.say('Hola')
    alias = 'gato azul'
    await q.say('Otra')
    const s = sayCalls(calls)
    expect(calls.some(c => c.includes('--alias') && c.includes('zorro rojo'))).toBe(true)
    expect(s[0]).toContain('--pid 4242 --alias zorro rojo --prioridad respuesta')
    expect(s[1]).toContain('--pid 4242 --alias gato azul --prioridad respuesta')
  })
  test('sin alias pasa solo --pid', async () => {
    const { calls, spawnFn } = recorder()
    const q = createProcessQueue(spawnFn, { getAlias: () => undefined, pid: 4242 })
    await q.say('Hola')
    expect(sayCalls(calls)[0]).toContain('--pid 4242 --prioridad respuesta')
    expect(sayCalls(calls)[0]).not.toContain('--alias')
  })
  test('speakerFlags: un fallo al leer el alias cae a --pid', () => {
    expect(
      speakerFlags({
        getAlias: () => {
          throw new Error('x')
        },
        pid: 7,
        getSessionId: () => '',
      }),
    ).toEqual(['--pid', '7'])
  })
  test('speakerFlags: pasa --session para reconocer a la principal', () => {
    expect(speakerFlags({ getAlias: () => 'buho rosa', pid: 7, getSessionId: () => '37cc9bbe-793b' })).toEqual([
      '--session',
      '37cc9bbe-793b',
      '--pid',
      '7',
      '--alias',
      'buho rosa',
    ])
  })
})
