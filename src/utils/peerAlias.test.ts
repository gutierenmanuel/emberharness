import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  diminutiveForms,
  matchAliasRef,
  normalizeAliasRef,
  readSessionAliases,
} from './peerAlias.js'

const zorroRojo = { animal: 'zorro', adjective: 'rojo', alias: 'zorro rojo', pid: 1 }
const zorroAzul = { animal: 'zorro', adjective: 'azul', alias: 'zorro azul', pid: 2 }
const gata = { animal: 'gata', adjective: 'veloz', alias: 'gata veloz', pid: 3 }
const gato = { animal: 'gato', adjective: 'gris', alias: 'gato gris', pid: 4 }
const leon = { animal: 'león', adjective: 'dorado', alias: 'león dorado', pid: 5 }
const raton = { animal: 'ratón', adjective: 'listo', alias: 'ratón listo', pid: 6 }
const ballena = { animal: 'ballena', adjective: 'azul', alias: 'ballena azul', pid: 7 }
const conejo = { animal: 'conejo', adjective: 'blanco', alias: 'conejo blanco', pid: 8 }
const oso = { animal: 'oso hormiguero', adjective: 'rojo', alias: 'oso hormiguero rojo', pid: 9 }
const all = [zorroRojo, gata, leon, raton, ballena, conejo, oso]
const pids = (xs: { pid: number }[]) => xs.map(x => x.pid)

describe('normalizeAliasRef', () => {
  test('lowercase, accents, spaces and filler words', () => {
    expect(normalizeAliasRef('  Claude   Zorro  ')).toBe('zorro')
    expect(normalizeAliasRef('al León')).toBe('leon')
    expect(normalizeAliasRef('a la gatita')).toBe('gatita')
    expect(normalizeAliasRef('el zorro rojo')).toBe('zorro rojo')
    expect(normalizeAliasRef('"zorrito",')).toBe('zorrito')
  })
})

describe('diminutiveForms', () => {
  test('derives the base with -o and -a', () => {
    expect(diminutiveForms('zorrito')).toContain('zorro')
    expect(diminutiveForms('gatita')).toEqual(expect.arrayContaining(['gato', 'gata']))
    expect(diminutiveForms('leoncito')).toContain('leon')
    expect(diminutiveForms('ratoncito')).toContain('raton')
    expect(diminutiveForms('ballenita')).toContain('ballena')
    expect(diminutiveForms('conejito')).toContain('conejo')
    expect(diminutiveForms('pajarillo')).toContain('pajaro')
  })
  test('a word that is not a diminutive stays itself', () => {
    expect(diminutiveForms('zorro')).toEqual(['zorro'])
    expect(diminutiveForms('ita')).toEqual(['ita'])
  })
})

describe('matchAliasRef', () => {
  test('animal, diminutive and full alias', () => {
    expect(pids(matchAliasRef('zorro', all))).toEqual([1])
    expect(pids(matchAliasRef('zorrito', all))).toEqual([1])
    expect(pids(matchAliasRef('zorro rojo', all))).toEqual([1])
    expect(pids(matchAliasRef('zorrito rojo', all))).toEqual([1])
    expect(pids(matchAliasRef('zorro roja', all))).toEqual([1])
    expect(pids(matchAliasRef('zorro verde', all))).toEqual([])
  })
  test('diminutives with accents in the animal', () => {
    expect(pids(matchAliasRef('leoncito', all))).toEqual([5])
    expect(pids(matchAliasRef('León', all))).toEqual([5])
    expect(pids(matchAliasRef('ratoncito', all))).toEqual([6])
    expect(pids(matchAliasRef('ballenita', all))).toEqual([7])
    expect(pids(matchAliasRef('conejito', all))).toEqual([8])
  })
  test('gender follows the candidates', () => {
    expect(pids(matchAliasRef('gatita', all))).toEqual([3])
    expect(pids(matchAliasRef('gatita', [gato]))).toEqual([4])
    expect(pids(matchAliasRef('gatito', [gato, gata]))).toEqual([4, 3])
  })
  test('multi-word animals', () => {
    expect(pids(matchAliasRef('osito hormiguero', all))).toEqual([9])
    expect(pids(matchAliasRef('oso hormiguero rojo', all))).toEqual([9])
  })
  test('filler prefixes', () => {
    expect(pids(matchAliasRef('Claude zorro', all))).toEqual([1])
    expect(pids(matchAliasRef('a la gatita', all))).toEqual([3])
  })
  test('ambiguity returns every candidate; full alias wins alone', () => {
    const both = [zorroRojo, zorroAzul]
    expect(pids(matchAliasRef('zorrito', both))).toEqual([1, 2])
    expect(pids(matchAliasRef('zorro azul', both))).toEqual([2])
    expect(pids(matchAliasRef('zorrito rojo', both))).toEqual([1])
  })
  test('empty or unknown ref', () => {
    expect(matchAliasRef('', all)).toEqual([])
    expect(matchAliasRef('perro', all)).toEqual([])
    expect(matchAliasRef('zorro', [{ pid: 1 }])).toEqual([])
  })
})

describe('readSessionAliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnh-alias-'))
  const ticks = (pid: number) => (pid === 10 || pid === 11 ? '555' : '')
  test('missing file gives an empty map', () => {
    expect(readSessionAliases({ runtimeDir: join(dir, 'nope') }).size).toBe(0)
  })
  test('corrupt file gives an empty map', () => {
    const d = mkdtempSync(join(tmpdir(), 'fnh-alias-'))
    writeFileSync(join(d, 'fnharness-session-names.json'), '{not json')
    expect(readSessionAliases({ runtimeDir: d }).size).toBe(0)
    writeFileSync(join(d, 'fnharness-session-names.json'), '[1,2]')
    expect(readSessionAliases({ runtimeDir: d }).size).toBe(0)
  })
  test('ignores dead pids, recycled pids and malformed entries', () => {
    const d = mkdtempSync(join(tmpdir(), 'fnh-alias-'))
    const e = (animal: string, start: string) => ({
      animal, adjective: 'rojo', emoji: '🦊', alias: `${animal} rojo`, start,
    })
    writeFileSync(
      join(d, 'fnharness-session-names.json'),
      JSON.stringify({
        '10': e('zorro', '555'),
        '11': e('gato', '999'), // recycled pid: start differs
        '12': e('perro', '555'), // dead pid
        '13': { animal: 5 },
        x: e('oso', '555'),
      }),
    )
    const m = readSessionAliases({ runtimeDir: d, startTicks: ticks })
    expect([...m.keys()]).toEqual([10])
    expect(m.get(10)).toEqual({ animal: 'zorro', adjective: 'rojo', emoji: '🦊', alias: 'zorro rojo' })
  })
})
