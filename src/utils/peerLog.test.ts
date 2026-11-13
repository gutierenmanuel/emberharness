import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendPeerLog,
  channelFor,
  formatPeerLog,
  readPeerLog,
  visibleChannels,
  type PeerLogEntry,
} from './peerLog.js'

const mk = (over: Partial<PeerLogEntry> & { text: string }): PeerLogEntry => ({
  ts: 1000,
  channel: 'normal',
  from: { pid: 1, name: 'a' },
  to: { pid: 2, name: 'b' },
  ...over,
})

describe('canales', () => {
  test('cyber en cuanto uno de los dos extremos lo es', () => {
    expect(channelFor(false, false)).toBe('normal')
    expect(channelFor(true, false)).toBe('cyber')
    expect(channelFor(false, true)).toBe('cyber')
    expect(channelFor(true, true)).toBe('cyber')
  })
  test('una sesion normal solo ve el canal normal; cyber puede ver los dos', () => {
    expect(visibleChannels(false)).toEqual(['normal'])
    expect(visibleChannels(false, 'all')).toEqual(['normal'])
    expect(visibleChannels(false, 'normal')).toEqual(['normal'])
    expect(visibleChannels(false, 'cyber')).toEqual([])
    expect(visibleChannels(true)).toEqual(['normal', 'cyber'])
    expect(visibleChannels(true, 'cyber')).toEqual(['cyber'])
    expect(visibleChannels(true, 'normal')).toEqual(['normal'])
  })
})

describe('historial en disco', () => {
  test('cada canal va a su fichero y una sesion normal nunca lee el cyber', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-peerlog-'))
    appendPeerLog(mk({ ts: 1, text: 'hola normal' }), dir)
    appendPeerLog(mk({ ts: 2, channel: 'cyber', text: 'secreto cyber' }), dir)
    expect(existsSync(join(dir, 'normal.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'cyber.jsonl'))).toBe(true)
    expect(statSync(join(dir, 'cyber.jsonl')).mode & 0o777).toBe(0o600)

    const normal = readPeerLog({ cyber: false, dir })
    expect(normal.map(e => e.text)).toEqual(['hola normal'])
    // Pedir el canal cyber desde una sesion normal no devuelve nada.
    expect(readPeerLog({ cyber: false, scope: 'cyber', dir })).toEqual([])

    const todo = readPeerLog({ cyber: true, dir })
    expect(todo.map(e => e.text)).toEqual(['hola normal', 'secreto cyber'])
    expect(readPeerLog({ cyber: true, scope: 'cyber', dir }).map(e => e.text)).toEqual(['secreto cyber'])
    expect(readPeerLog({ cyber: true, scope: 'normal', dir }).map(e => e.text)).toEqual(['hola normal'])
  })

  test('el canal lo manda el fichero, no el campo del registro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-peerlog-'))
    // Un registro que dice "cyber" pero esta en normal.jsonl se trata como normal.
    appendFileSync(join(dir, 'normal.jsonl'), JSON.stringify(mk({ channel: 'cyber', text: 'mal puesto' })) + '\n')
    const out = readPeerLog({ cyber: false, dir })
    expect(out.length).toBe(1)
    expect(out[0]!.channel).toBe('normal')
  })

  test('limit, orden por fecha, lineas corruptas y filtro por peer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-peerlog-'))
    appendPeerLog(mk({ ts: 30, text: 'c', from: { pid: 7, name: 'bot' } }), dir)
    appendPeerLog(mk({ ts: 10, text: 'a' }), dir)
    appendFileSync(join(dir, 'normal.jsonl'), 'esto no es json\n')
    appendPeerLog(mk({ ts: 20, text: 'b', to: { pid: 9, sessionId: 'abcdef12-0000' } }), dir)
    expect(readPeerLog({ cyber: false, dir }).map(e => e.text)).toEqual(['a', 'b', 'c'])
    expect(readPeerLog({ cyber: false, dir, limit: 2 }).map(e => e.text)).toEqual(['b', 'c'])
    expect(readPeerLog({ cyber: false, dir, peer: '7' }).map(e => e.text)).toEqual(['c'])
    expect(readPeerLog({ cyber: false, dir, peer: 'BOT' }).map(e => e.text)).toEqual(['c'])
    expect(readPeerLog({ cyber: false, dir, peer: 'abcdef' }).map(e => e.text)).toEqual(['b'])
  })

  test('sin historial devuelve vacio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-peerlog-'))
    expect(readPeerLog({ cyber: true, dir })).toEqual([])
  })

  test('formato: cabecera con canal y textos largos recortados', () => {
    const out = formatPeerLog([mk({ ts: 0, text: 'x'.repeat(30) })], 10)
    expect(out).toContain('[1970-01-01 00:00:00] [normal] pid 1 "a" → pid 2 "b"')
    expect(out).toContain('xxxxxxxxxx… [+20 chars]')
  })
})
