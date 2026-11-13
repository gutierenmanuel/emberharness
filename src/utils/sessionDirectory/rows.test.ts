import { describe, expect, test } from 'bun:test'
import { ageOf, buildEntries, formatAge, groupOf, matchesQuery, originLabel, summaryLine } from './rows.js'
import type { SessionRow } from './types.js'

function row(over: Partial<SessionRow>): SessionRow {
  return {
    key: over.key ?? 'k',
    self: false,
    harness: 'fnharness',
    origin: 'headless',
    status: 'idle',
    title: 'titulo',
    lastActivity: 0,
    actions: [],
    ...over,
  }
}

describe('groupOf', () => {
  test('por estado, con bg y recent aparte', () => {
    expect(groupOf(row({ status: 'waiting' }))).toBe('Esperando')
    expect(groupOf(row({ status: 'busy' }))).toBe('Trabajando')
    expect(groupOf(row({ status: 'idle' }))).toBe('En espera')
    expect(groupOf(row({ origin: 'bg', status: 'busy' }))).toBe('Segundo plano')
    expect(groupOf(row({ origin: 'bg', status: 'failed' }))).toBe('Segundo plano')
    expect(groupOf(row({ origin: 'recent', status: 'done' }))).toBe('Recientes')
  })
})

describe('buildEntries', () => {
  const rows = [
    row({ key: 'a', status: 'waiting', title: 'espera permiso' }),
    row({ key: 'b', status: 'busy', title: 'compilando', cwd: '/home/u/proyecto', account: 'personal', model: 'sonnet' }),
    row({ key: 'c', status: 'idle', title: 'quieta', origin: 'kitty' }),
    row({ key: 'd', status: 'idle', title: 'otra quieta', origin: 'tmux', harness: 'claude' }),
    row({ key: 'e', origin: 'recent', status: 'done', title: 'vieja' }),
  ]

  test('cabeceras solo de grupos no vacíos y en el orden de los grupos', () => {
    const entries = buildEntries(rows, '')
    expect(entries.map(e => (e.type === 'header' ? `# ${e.label} ${e.count}` : (e as any).row.key))).toEqual([
      '# Esperando 1', 'a', '# Trabajando 1', 'b', '# En espera 2', 'c', 'd', '# Recientes 1', 'e',
    ])
  })

  test('el orden dentro del grupo es el de entrada', () => {
    const keys = buildEntries([rows[3]!, rows[2]!], '').filter(e => e.type === 'row').map(e => (e as any).row.key)
    expect(keys).toEqual(['d', 'c'])
  })

  test('el filtro exige todas las palabras, sin mayúsculas, sobre titulo cwd account:model origen harness', () => {
    const keys = (q: string) => buildEntries(rows, q).filter(e => e.type === 'row').map(e => (e as any).row.key)
    expect(keys('COMPILANDO')).toEqual(['b'])
    expect(keys('proyecto personal')).toEqual(['b'])
    expect(keys('personal:sonnet')).toEqual(['b'])
    expect(keys('quieta kitty')).toEqual(['c'])
    expect(keys('claude tmux')).toEqual(['d'])
    expect(keys('quieta zzz')).toEqual([])
    expect(keys('   ')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(buildEntries(rows, 'zzz')).toEqual([])
  })

  test('el filtro quita también las cabeceras que quedan vacías', () => {
    const entries = buildEntries(rows, 'vieja')
    expect(entries).toEqual([
      { type: 'header', label: 'Recientes', count: 1 },
      { type: 'row', row: rows[4]! },
    ])
    expect(matchesQuery(rows[0]!, 'espera permiso')).toBe(true)
  })
})

describe('formatAge y ageOf', () => {
  test('segundos, minutos, horas y días', () => {
    expect(formatAge(12_000)).toBe('12s')
    expect(formatAge(59_999)).toBe('59s')
    expect(formatAge(120_000)).toBe('2m')
    expect(formatAge(3 * 3600_000)).toBe('3h')
    expect(formatAge(2 * 86400_000 + 5)).toBe('2d')
    expect(formatAge(-5000)).toBe('0s')
  })
  test('ageOf', () => {
    expect(ageOf(row({ lastActivity: 1000 }), 1000 + 180_000)).toBe('3m')
  })
})

describe('summaryLine', () => {
  test('vivas, esperando y salas de Element; omite ceros', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ key: `p${i}`, pid: i + 1 })),
      row({ key: 'w1', pid: 20, status: 'waiting' }),
      row({ key: 'w2', pid: 21, status: 'waiting' }),
      row({ key: 'el', origin: 'element', tmux: { socket: 'm', session: 's' } }),
      row({ key: 'bg', origin: 'bg', status: 'busy', pid: 30 }),
      row({ key: 'bgd', origin: 'bg', status: 'done' }),
      row({ key: 'rec', origin: 'recent', status: 'done' }),
    ]
    expect(summaryLine(rows)).toBe('10 vivas · 2 esperan respuesta · 1 sala de Element en tmux')
  })

  test('singular, sin esperas y sin nada vivo', () => {
    expect(summaryLine([row({ pid: 1 })])).toBe('1 viva')
    expect(summaryLine([row({ origin: 'recent', status: 'done' })])).toBe('sin sesiones vivas')
    expect(summaryLine([row({ pid: 1, status: 'waiting' })])).toBe('1 viva · 1 espera respuesta')
  })
})

describe('originLabel', () => {
  test('etiquetas cortas; self es esta', () => {
    expect(originLabel(row({ origin: 'kitty' }))).toBe('kitty')
    expect(originLabel(row({ origin: 'element' }))).toBe('element')
    expect(originLabel(row({ origin: 'tmux' }))).toBe('tmux')
    expect(originLabel(row({ origin: 'bg' }))).toBe('bg')
    expect(originLabel(row({ origin: 'headless' }))).toBe('head')
    expect(originLabel(row({ origin: 'recent' }))).toBe('rec')
    expect(originLabel(row({ origin: 'kitty', self: true }))).toBe('esta')
  })
})
