import { describe, expect, test } from 'bun:test'
import { parseEnviron, parsePpid, readProcs } from './procReader.js'
import {
  flattenKittyLs,
  parseElementConversations,
  parseElementState,
  parseTmuxPanes,
} from './terminals.js'

describe('procReader', () => {
  test('parsePpid soporta paréntesis en el nombre del proceso', () => {
    expect(parsePpid('123 (bash) S 45 123 123 0 -1')).toBe(45)
    expect(parsePpid('123 (a) b (c)) S 77 1 1')).toBe(77)
    expect(parsePpid('basura')).toBeUndefined()
  })

  test('parseEnviron separa por NUL y respeta los = del valor', () => {
    expect(parseEnviron('A=1\0B=x=y\0\0SINIGUAL\0')).toEqual({ A: '1', B: 'x=y' })
  })

  test('readProcs sube por los ancestros del propio proceso y salta el entorno pedido', async () => {
    const procs = await readProcs([process.pid], new Set([process.pid]))
    expect(procs[process.pid]?.ppid).toBe(process.ppid)
    expect(procs[process.pid]?.env).toEqual({})
    // El padre del proceso de test también está en el mapa, con su entorno.
    expect(procs[process.ppid]).toBeDefined()
  })

  test('readProcs ignora procesos que no existen', async () => {
    expect(await readProcs([2 ** 22 + 12345])).toEqual({})
  })
})

describe('terminals', () => {
  test('parseTmuxPanes lee sesión y pid separados por tabulador', () => {
    const out = 'pc-a-c-1\t4242\nconv con espacios\t7\n\nmal\tx\n'
    expect(parseTmuxPanes('matrixterm', out)).toEqual([
      { socket: 'matrixterm', session: 'pc-a-c-1', panePid: 4242 },
      { socket: 'matrixterm', session: 'conv con espacios', panePid: 7 },
    ])
  })

  test('flattenKittyLs aplana ventanas de SO, pestañas y ventanas', () => {
    const ls = [
      {
        id: 1,
        tabs: [
          {
            windows: [
              {
                id: 3,
                pid: 100,
                cwd: '/tmp',
                title: 't',
                is_focused: true,
                foreground_processes: [{ pid: 100 }, { pid: 222 }],
              },
              { id: 4, pid: 101, is_focused: false },
              { id: 'x' },
            ],
          },
        ],
      },
    ]
    expect(flattenKittyLs('unix:/tmp/kitty-1', ls)).toEqual([
      { listenOn: 'unix:/tmp/kitty-1', windowId: 3, pid: 100, foregroundPids: [100, 222], cwd: '/tmp', title: 't', isFocused: true },
      { listenOn: 'unix:/tmp/kitty-1', windowId: 4, pid: 101, foregroundPids: [], cwd: undefined, title: undefined, isFocused: false },
    ])
    expect(flattenKittyLs('unix:/x', { no: 'array' })).toEqual([])
  })

  test('parseElementState exige session y socket', () => {
    const ok = parseElementState('pc-a', '/s/pc-a/x.json', {
      session: 'x',
      socket: 'matrixterm',
      session_id: 'abc',
      workdir: '/w',
      config_dir: '/c',
      started_at: '2026-01-01T00:00:00Z',
    })
    expect(ok).toEqual({
      agent: 'pc-a',
      stateFile: '/s/pc-a/x.json',
      session: 'x',
      socket: 'matrixterm',
      sessionId: 'abc',
      workdir: '/w',
      configDir: '/c',
      startedAt: '2026-01-01T00:00:00Z',
    })
    expect(parseElementState('a', 'f', { hooks: {} })).toBeNull()
    expect(parseElementState('a', 'f', { session: 'x' })).toBeNull()
  })

  test('parseElementConversations lee las conversaciones con su estado', () => {
    const conv = parseElementConversations('pc-a', {
      space_id: '!s',
      conversations: [
        { room_id: '!r', session: 'pc-a-c-1', title: 'hola', claude_session_id: 'sid', workdir: '/w', status: 'suspended', last_activity: '2026-01-01' },
        { title: 'sin sesión' },
      ],
    })
    expect(conv).toEqual([
      { agent: 'pc-a', roomId: '!r', session: 'pc-a-c-1', title: 'hola', claudeSessionId: 'sid', workdir: '/w', status: 'suspended', lastActivity: '2026-01-01' },
    ])
  })
})
