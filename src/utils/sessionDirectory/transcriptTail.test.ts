import { describe, expect, test } from 'bun:test'
import { tailFromJsonl } from './transcriptTail.js'

const line = (o: object) => JSON.stringify(o)

describe('tailFromJsonl', () => {
  const jsonl = [
    line({ type: 'user', message: { role: 'user', content: 'hola\nmundo' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'buenas' }, { type: 'tool_use', name: 'Bash' }] } }),
    line({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }),
    line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
    line({ type: 'summary', summary: 'no' }),
    'no es json',
  ].join('\n')

  test('une el texto, marca la herramienta y descarta metadatos y etiquetas del sistema', () => {
    expect(tailFromJsonl(jsonl, 12)).toEqual(['> hola mundo', '· buenas', '[Bash]'])
  })

  test('se queda con las últimas líneas', () => {
    expect(tailFromJsonl(jsonl, 2)).toEqual(['· buenas', '[Bash]'])
  })

  test('descarta la primera línea cuando el trozo empieza a medias', () => {
    expect(tailFromJsonl(`{"type":"user","mess\n${jsonl}`, 12, true)).toEqual(['> hola mundo', '· buenas', '[Bash]'])
  })
})
