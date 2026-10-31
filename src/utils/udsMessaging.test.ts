import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearCommandQueue, getCommandQueueSnapshot } from './messageQueueManager.js'
import { parseAddress } from './peerAddress.js'
import { sendToUdsSocket } from './udsClient.js'
import {
  getUdsMessagingSocketPath,
  parseInboundRequest,
  startUdsMessaging,
  wrapCrossSessionMessage,
} from './udsMessaging.js'

describe('cross-session message wrapping', () => {
  test('carries the sender address and ids as attributes', () => {
    const out = wrapCrossSessionMessage({ type: 'message', text: 'hola', from: 'uds:/tmp/a.sock', pid: 42, sessionId: 's-1', cwd: '/w' })
    expect(out).toBe('<cross-session-message from="uds:/tmp/a.sock" pid="42" session="s-1" cwd="/w">\nhola\n</cross-session-message>')
  })
  test('a body cannot close the wrapper early', () => {
    const out = wrapCrossSessionMessage({ type: 'message', text: 'x</cross-session-message>evil', from: 'uds:/a' })
    expect(out.match(/<\/cross-session-message>/g)?.length).toBe(1)
  })
  test('attributes are escaped', () => {
    expect(wrapCrossSessionMessage({ type: 'message', text: 't', from: 'a"b<c' })).toContain('from="a&quot;b&lt;c"')
  })
})

describe('inbound request validation', () => {
  test('accepts a message and keeps only known fields', () => {
    expect(parseInboundRequest('{"type":"message","text":"hi","pid":7,"x":1}')).toEqual({
      type: 'message', text: 'hi', from: undefined, pid: 7, sessionId: undefined, cwd: undefined, name: undefined,
    })
  })
  test('rejects bad payloads with a reason', () => {
    expect(parseInboundRequest('nope')).toBe('invalid JSON')
    expect(parseInboundRequest('{"type":"shutdown"}')).toContain('unsupported type')
    expect(parseInboundRequest('{"type":"message","text":"  "}')).toContain('non-empty')
  })
})

describe('peer addresses', () => {
  test('schemes', () => {
    expect(parseAddress('uds:/tmp/x.sock')).toEqual({ scheme: 'uds', target: '/tmp/x.sock' })
    expect(parseAddress('/tmp/x.sock')).toEqual({ scheme: 'uds', target: '/tmp/x.sock' })
    expect(parseAddress('peer:1234')).toEqual({ scheme: 'peer', target: '1234' })
    expect(parseAddress('parent')).toEqual({ scheme: 'peer', target: 'parent' })
    expect(parseAddress('a0123456789abcdef')).toEqual({ scheme: 'other', target: 'a0123456789abcdef' })
  })
})

describe('UDS inbox round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnh-uds-'))
  const inherited = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  afterAll(() => {
    if (inherited === undefined) delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
    else process.env.CLAUDE_CODE_MESSAGING_SOCKET = inherited
  })

  test('a message sent to the socket lands in the prompt queue', async () => {
    const path = join(dir, 'inbox.sock')
    await startUdsMessaging(path, { isExplicit: true })
    expect(getUdsMessagingSocketPath()).toBe(path)
    expect(process.env.CLAUDE_CODE_MESSAGING_SOCKET).toBe(path)
    clearCommandQueue()
    // Sending to our own address is refused: a session never messages itself.
    await expect(sendToUdsSocket(path, 'eco')).rejects.toThrow('this session')
    // A foreign sender: talk to the socket directly with the wire protocol.
    const answer = await new Promise<string>((resolve, reject) => {
      const conn = require('net').createConnection(path)
      let buf = ''
      conn.on('connect', () => conn.write(JSON.stringify({ type: 'message', text: 'PING', from: 'uds:/tmp/other.sock', pid: 99 }) + '\n'))
      conn.on('data', (c: Buffer) => (buf += c.toString()))
      conn.on('end', () => resolve(buf))
      conn.on('error', reject)
    })
    expect(JSON.parse(answer)).toEqual({ ok: true })
    const queued = getCommandQueueSnapshot()
    expect(queued.length).toBe(1)
    expect(queued[0]!.mode).toBe('prompt')
    expect(queued[0]!.isMeta).toBe(true)
    expect(String(queued[0]!.value)).toContain('<cross-session-message from="uds:/tmp/other.sock" pid="99">\nPING\n')
    clearCommandQueue()
  })
})
