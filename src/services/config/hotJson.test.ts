import { describe, expect, test } from 'bun:test'
import { mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHotJson } from './hotJson.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fnh-hot-'))
  const file = join(dir, 'x.json')
  let t = 0
  const errors: string[] = []
  const hot = createHotJson<{ n: number }>({
    file: 'x.json',
    defaults: { n: 0 },
    merge: (d, u) => {
      if (typeof (u as { n?: unknown }).n !== 'number') throw new Error('n inválido')
      return { n: (u as { n: number }).n }
    },
    onError: m => errors.push(m),
    env: { CLAUDE_CONFIG_DIR: dir },
    now: () => t,
  })
  const write = (body: string, mtimeSec: number) => {
    writeFileSync(file, body)
    utimesSync(file, mtimeSec, mtimeSec)
  }
  return { hot, write, errors, advance: (ms: number) => (t += ms) }
}

describe('createHotJson', () => {
  test('sin fichero devuelve los defaults', () => {
    expect(setup().hot.get()).toEqual({ n: 0 })
  })

  test('recarga al cambiar el fichero, pero no antes del intervalo', () => {
    const { hot, write, advance } = setup()
    write('{"n":1}', 1000)
    expect(hot.get()).toEqual({ n: 1 })
    write('{"n":2}', 2000)
    expect(hot.get()).toEqual({ n: 1 }) // aún dentro del intervalo
    advance(1500)
    expect(hot.get()).toEqual({ n: 2 })
  })

  test('un JSON inválido mantiene el último bueno y avisa una sola vez', () => {
    const { hot, write, errors, advance } = setup()
    write('{"n":5}', 1000)
    expect(hot.get()).toEqual({ n: 5 })
    write('{roto', 2000)
    advance(1500)
    expect(hot.get()).toEqual({ n: 5 })
    advance(1500)
    expect(hot.get()).toEqual({ n: 5 })
    expect(errors).toHaveLength(1)
    write('{"n":6}', 3000)
    advance(1500)
    expect(hot.get()).toEqual({ n: 6 })
  })
})
