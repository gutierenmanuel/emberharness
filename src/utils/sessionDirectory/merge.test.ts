import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canResumeInPlace } from './actions.js'
import { mergeSessions, MAX_RECENT } from './merge.js'
import type {
  BgEntry,
  DirectoryInput,
  ElementConversation,
  ElementState,
  KittyWindow,
  RegistryEntry,
  RegistryRecord,
  SessionRow,
  TmuxPane,
} from './types.js'

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')) as T
}

const NOW = 1794582000000
const CLAUDE_SID = '865085ed-5a1c-4c7e-9d0b-2f6e1a7c3b11'
const FN_SID = 'f1a2b3c4-1111-4222-8333-444455556666'
const BG_SID = 'bbbb1111-2222-4333-8444-555566667777'

const claudeRecord = fixture<RegistryRecord>('registry-claude.json')
const fnRecord = fixture<RegistryRecord>('registry-fnharness.json')
const bgMeta = fixture<BgEntry['meta']>('bg-meta.json')
const kittyWindows = fixture<KittyWindow[]>('kitty-windows.json')
const tmuxPanes = fixture<TmuxPane[]>('tmux-panes.json')

const rawState = fixture<Record<string, string>>('element-state.json')
const elementState: ElementState = {
  agent: rawState.profile!,
  stateFile: '/home/user/.local/state/matrix/pc-a/pc-a-c-1113-1558.json',
  session: rawState.session!,
  socket: rawState.socket!,
  sessionId: rawState.session_id,
  workdir: rawState.workdir,
  configDir: rawState.config_dir,
  startedAt: rawState.started_at,
}
const rawConvs = fixture<{ conversations: Array<Record<string, string>> }>('conversations-pc-a.json')
const conversations: ElementConversation[] = rawConvs.conversations.map(c => ({
  agent: 'pc-a',
  roomId: c.room_id,
  session: c.session!,
  title: c.title,
  claudeSessionId: c.claude_session_id,
  workdir: c.workdir,
  status: c.status,
  lastActivity: c.last_activity,
}))

const claudeEntry = (over: Partial<RegistryRecord> = {}): RegistryEntry => ({
  harness: 'claude',
  configDir: '/home/user/.claude',
  record: { ...claudeRecord, ...over },
})
const fnEntry = (over: Partial<RegistryRecord> = {}): RegistryEntry => ({
  harness: 'fnharness',
  configDir: '/home/user/.fnharness',
  record: { ...fnRecord, ...over },
})
const bgEntry = (status: BgEntry['status'], over: Partial<BgEntry['meta']> = {}): BgEntry => ({
  meta: { ...bgMeta, ...over },
  status,
  configDir: '/home/user/.fnharness',
})

function input(over: Partial<DirectoryInput> = {}): DirectoryInput {
  return {
    now: NOW,
    registry: [],
    bg: [],
    elementStates: [],
    elementConversations: [],
    tmuxPanes: [],
    kittyWindows: [],
    procs: {},
    transcripts: {},
    recent: [],
    ...over,
  }
}

const byKey = (rows: SessionRow[], key: string) => rows.find(r => r.key === key)

describe('Element', () => {
  const procs = { 3211889: { ppid: 3211800, env: { CLAUDE_TERM_SESSION: 'pc-a-c-1113-1558' }, cmdline: 'claude' } }

  test('sala de Element + registro de claude con el mismo sessionId: una sola fila element con el título de la conversación', () => {
    const rows = mergeSessions(
      input({
        registry: [claudeEntry()],
        elementStates: [elementState],
        elementConversations: conversations,
        tmuxPanes,
        procs,
        transcripts: { [CLAUDE_SID]: { title: 'otro título', lastModified: 1794581999000 } },
      }),
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.origin).toBe('element')
    expect(r.harness).toBe('claude')
    expect(r.title).toBe('revisar el selector de sesiones')
    expect(r.pid).toBe(3211889)
    expect(r.sessionId).toBe(CLAUDE_SID)
    expect(r.socket).toBe('/run/user/1000/cc-socks/3211889.sock')
    expect(r.tmux).toEqual({ socket: 'matrixterm', session: 'pc-a-c-1113-1558' })
    expect(r.room).toBe('!IBLxAAAA:matrix.local')
    expect(r.actions).toEqual(['attach-tmux'])
    expect(r.disabledActions?.['fork-here']).toContain('Matrix')
    expect(r.lastActivity).toBe(Date.parse('2026-11-13T16:05:00+01:00'))
  })

  test('se funde por sessionId aunque el entorno no diga nada y el panel no sea ancestro', () => {
    const rows = mergeSessions(
      input({
        registry: [claudeEntry()],
        elementStates: [elementState],
        elementConversations: conversations,
        tmuxPanes,
        procs: { 3211889: { ppid: 1, env: {}, cmdline: 'claude' } },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.origin).toBe('element')
  })

  test('sala con panel vivo y sin registro genera fila idle con el título de la conversación', () => {
    const rows = mergeSessions(
      input({ elementStates: [elementState], elementConversations: conversations, tmuxPanes }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      origin: 'element',
      status: 'idle',
      harness: 'claude',
      sessionId: CLAUDE_SID,
      title: 'revisar el selector de sesiones',
    })
    expect(rows[0]!.pid).toBeUndefined()
    expect(rows[0]!.actions).toEqual(['attach-tmux'])
  })

  test('estado sin panel vivo y conversación suspendida no generan fila', () => {
    const rows = mergeSessions(
      input({ elementStates: [elementState], elementConversations: conversations, tmuxPanes: [tmuxPanes[1]!] }),
    )
    expect(rows).toEqual([])
    expect(mergeSessions(input({ elementConversations: conversations }))).toEqual([])
  })
})

describe('bg', () => {
  test('bg en marcha con su registro (kind bg): una sola fila bg con pid, socket y estado del registro', () => {
    const rows = mergeSessions(
      input({
        registry: [
          fnEntry({ pid: 4000101, sessionId: BG_SID, kind: 'bg', status: 'waiting', waitingFor: 'permiso', messagingSocketPath: '/tmp/fnharness-socks/4000101.sock' }),
        ],
        bg: [bgEntry('running')],
        procs: { 4000101: { ppid: 4000100, env: {}, cmdline: 'bun cli' } },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      origin: 'bg',
      status: 'waiting',
      waitingFor: 'permiso',
      pid: 4000101,
      bgId: 'bbbb1111',
      socket: '/tmp/fnharness-socks/4000101.sock',
    })
    expect(rows[0]!.actions).toEqual(['view-log', 'stop'])
  })

  test('bg en marcha sin registro: busy; bg terminada conserva su estado y ofrece reanudar', () => {
    const rows = mergeSessions(
      input({
        bg: [
          bgEntry('running'),
          bgEntry('failed', { id: 'cccc2222', sessionId: 'cccc2222-0000-4000-8000-000000000000', pid: 4000200, prompt: 'otra cosa' }),
        ],
      }),
    )
    const run = byKey(rows, BG_SID)!
    expect(run).toMatchObject({ status: 'busy', pid: 4000100, origin: 'bg', title: 'revisa los tests de sesiones y dime que falla' })
    const dead = rows.find(r => r.bgId === 'cccc2222')!
    expect(dead).toMatchObject({ status: 'failed', origin: 'bg' })
    expect(dead.pid).toBeUndefined()
    expect(dead.actions).toEqual(['resume-here', 'view-log'])
  })

  test('bg terminada con un registro vivo del mismo sessionId (reanudada en kitty): una fila, origen no bg', () => {
    const rows = mergeSessions(
      input({
        registry: [fnEntry({ sessionId: BG_SID })],
        bg: [bgEntry('done')],
        procs: { 1061307: { ppid: 1, env: {}, cmdline: 'bun cli' } },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.origin).toBe('headless')
    expect(rows[0]!.bgId).toBe('bbbb1111')
  })
})

describe('kitty', () => {
  const procs = {
    1061307: { ppid: 1061250, env: { KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1000' }, cmdline: 'bun cli' },
    1061250: { ppid: 1061200, env: {} },
    1061200: { ppid: 1, env: {} },
  }
  const win = { ...kittyWindows[0]!, foregroundPids: [] as number[] }

  test('ventana encontrada por un pid ancestro (sesión -> padre -> shell de la ventana)', () => {
    const rows = mergeSessions(input({ registry: [fnEntry()], procs, kittyWindows: [win] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.origin).toBe('kitty')
    expect(rows[0]!.kitty).toEqual({ listenOn: 'unix:/tmp/kitty-1000', windowId: 3, focused: true })
    expect(rows[0]!.actions).toEqual(['focus-kitty', 'fork-here'])
  })

  test('socket caducado: KITTY_* en el entorno pero ninguna ventana lo confirma -> no es kitty', () => {
    const rows = mergeSessions(
      input({
        registry: [fnEntry()],
        procs,
        // kitty sigue vivo pero con otras ventanas: ninguna es ancestro de la sesión
        kittyWindows: [kittyWindows[1]!],
      }),
    )
    expect(rows[0]!.origin).toBe('headless')
    expect(rows[0]!.kitty).toBeUndefined()
    const sinKitty = mergeSessions(input({ registry: [fnEntry()], procs }))
    expect(sinKitty[0]!.origin).toBe('headless')
  })

  test('el registro puede indicar su ventana (kittyWindowId + kittyListenOn) si sigue listada', () => {
    const rec = { origin: { kittyWindowId: 4, kittyListenOn: 'unix:/tmp/kitty-1000' } }
    const ok = mergeSessions(input({ registry: [fnEntry({ ...rec, pid: 9999 })], kittyWindows, procs: { 9999: { ppid: 1, env: {} } } }))
    expect(ok[0]!.origin).toBe('kitty')
    expect(ok[0]!.kitty?.windowId).toBe(4)
    const caducado = mergeSessions(
      input({ registry: [fnEntry({ pid: 9999, origin: { kittyWindowId: 4, kittyListenOn: 'unix:/tmp/kitty-viejo' } })], kittyWindows, procs: { 9999: { ppid: 1, env: {} } } }),
    )
    expect(caducado[0]!.origin).toBe('headless')
  })

  test('tmux por entorno cuando no hay ventana de kitty', () => {
    const rows = mergeSessions(
      input({
        registry: [fnEntry()],
        procs: { 1061307: { ppid: 1, env: { TMUX: '/tmp/tmux-1000/default,1,0', TERM: 'tmux-256color' } } },
      }),
    )
    expect(rows[0]!.origin).toBe('tmux')
    expect(rows[0]!.tmux?.socket).toBe('default')
  })

  test('tmux por panel ancestro; con ventana kitty confirmada gana kitty', () => {
    const procsPane = { 1061307: { ppid: 2500100, env: {} }, 2500100: { ppid: 1, env: {} } }
    const rows = mergeSessions(input({ registry: [fnEntry()], procs: procsPane, tmuxPanes }))
    expect(rows[0]!.origin).toBe('tmux')
    expect(rows[0]!.tmux).toEqual({ socket: 'default', session: 'trabajo' })
    const both = mergeSessions(input({ registry: [fnEntry()], procs: procsPane, tmuxPanes, kittyWindows: [{ ...kittyWindows[0]!, pid: 2500100 }] }))
    expect(both[0]!.origin).toBe('kitty')
  })

  test('sdk gana a kitty confirmado', () => {
    const rows = mergeSessions(input({ registry: [fnEntry({ entrypoint: 'sdk-cli' })], procs, kittyWindows: [win] }))
    expect(rows[0]!.origin).toBe('headless')
    expect(rows[0]!.actions).toEqual(['fork-here', 'send-message'])
  })
})

describe('self, orden y descartes', () => {
  test('self queda marcada y va primera en su grupo; el resto por grupo y actividad', () => {
    const mk = (pid: number, sid: string, status: RegistryRecord['status'], updatedAt: number) =>
      fnEntry({ pid, sessionId: sid, status, updatedAt })
    const rows = mergeSessions(
      input({
        selfPid: 12,
        registry: [
          mk(10, 'a', 'idle', 100),
          mk(11, 'b', 'busy', 900),
          mk(12, 'c', 'idle', 50),
          mk(13, 'd', 'waiting', 10),
          mk(14, 'e', 'idle', 500),
          mk(15, 'f', 'busy', 950),
        ],
        bg: [bgEntry('done')],
      }),
    )
    expect(rows.map(r => r.key)).toEqual(['d', 'f', 'b', 'c', 'e', 'a', BG_SID])
    const self = byKey(rows, 'c')!
    expect(self.self).toBe(true)
    expect(self.actions).toEqual([])
    expect(rows.filter(r => r.self)).toHaveLength(1)
  })

  test('self también por sessionId', () => {
    const rows = mergeSessions(input({ selfSessionId: FN_SID, registry: [fnEntry()] }))
    expect(rows[0]!.self).toBe(true)
  })

  test('fila con pid reutilizado (cmdline ajeno) se descarta', () => {
    const rows = mergeSessions(
      input({
        registry: [fnEntry({ pid: 555, sessionId: 'viejo' }), fnEntry({ pid: 556, sessionId: 'bueno' }), fnEntry({ pid: 557, sessionId: 'sin-cmdline' })],
        procs: {
          555: { ppid: 1, env: {}, cmdline: '/usr/bin/vim notas.md' },
          556: { ppid: 1, env: {}, cmdline: '/home/u/.bun/bin/bun run cli.tsx' },
        },
      }),
    )
    expect(rows.map(r => r.key).sort()).toEqual(['bueno', 'sin-cmdline'])
  })

  test('registros con el mismo sessionId no duplican fila', () => {
    const rows = mergeSessions(
      input({ registry: [fnEntry({ pid: 1, updatedAt: 1 }), fnEntry({ pid: 2, updatedAt: 9 })] }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pid).toBe(2)
  })

  test('harness: marca explícita, rasgos de claude, config .claude o fnharness', () => {
    const rows = mergeSessions(
      input({
        registry: [
          fnEntry({ pid: 1, sessionId: 'h1', harness: 'claude' }),
          { harness: 'fnharness', configDir: '/home/u/.claude-eni', record: { pid: 2, sessionId: 'h2' } },
          { harness: 'fnharness', configDir: '/home/u/.fnharness', record: { pid: 3, sessionId: 'h3', version: '2.1.1' } },
          fnEntry({ pid: 4, sessionId: 'h4' }),
        ],
      }),
    )
    expect(rows.map(r => [r.key, r.harness]).sort()).toEqual([
      ['h1', 'claude'], ['h2', 'claude'], ['h3', 'claude'], ['h4', 'fnharness'],
    ])
  })

  test('título: transcript, primer prompt, nombre del registro y por último el directorio', () => {
    const rows = mergeSessions(
      input({
        registry: [
          fnEntry({ pid: 1, sessionId: 't1', name: 'nombre' }),
          fnEntry({ pid: 2, sessionId: 't2', name: 'nombre' }),
          fnEntry({ pid: 3, sessionId: 't3', name: 'nombre' }),
          fnEntry({ pid: 4, sessionId: 't4' }),
        ],
        transcripts: {
          t1: { title: 'titulo', firstPrompt: 'prompt', lastModified: 5 },
          t2: { firstPrompt: 'prompt' },
        },
      }),
    )
    expect(rows.map(r => [r.key, r.title]).sort()).toEqual([
      ['t1', 'titulo'], ['t2', 'prompt'], ['t3', 'nombre'], ['t4', 'fn_registry'],
    ])
  })

  test('lastActivity es el máximo de updatedAt, transcript y Matrix', () => {
    const rows = mergeSessions(
      input({
        registry: [claudeEntry({ updatedAt: 1000 })],
        elementStates: [elementState],
        elementConversations: [{ ...conversations[0]!, lastActivity: '2026-11-13T16:05:00+01:00' }],
        tmuxPanes,
        procs: { 3211889: { ppid: 3211800, env: {} } },
        transcripts: { [CLAUDE_SID]: { lastModified: 2000 } },
      }),
    )
    expect(rows[0]!.lastActivity).toBe(Date.parse('2026-11-13T16:05:00+01:00'))
  })
})

describe('recientes', () => {
  const recent = Array.from({ length: 14 }, (_, i) => ({
    sessionId: `r${i}`,
    cwd: '/x',
    title: `reciente ${i}`,
    lastModified: 1000 + i,
    configDir: '/home/user/.fnharness',
  }))

  test('solo las 10 más recientes y sin duplicar sesiones vivas', () => {
    const rows = mergeSessions(
      input({
        registry: [fnEntry({ sessionId: 'r13' }), fnEntry({ pid: 2, sessionId: 'r12' })],
        recent: [...recent, recent[0]!],
      }),
    )
    const rec = rows.filter(r => r.origin === 'recent')
    expect(rec).toHaveLength(MAX_RECENT)
    expect(rec.map(r => r.sessionId)).toEqual(['r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r2'])
    expect(rec.every(r => r.status === 'done' && r.pid === undefined)).toBe(true)
    expect(rec[0]!.actions).toEqual(['resume-here'])
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
  })

  test('no repite la sesión actual aunque no tenga registro', () => {
    const rows = mergeSessions(input({ selfSessionId: 'r1', recent: recent.slice(0, 3) }))
    expect(rows.map(r => r.key)).toEqual(['r2', 'r0'])
  })
})

describe('canResumeInPlace sobre filas fundidas', () => {
  test('una sesión viva no se reanuda en el sitio; una reciente sí', () => {
    const rows = mergeSessions(
      input({
        registry: [fnEntry()],
        recent: [{ sessionId: 'vieja', lastModified: 1, configDir: '/x/.fnharness' }],
      }),
    )
    expect(canResumeInPlace(FN_SID, rows)).toBe(false)
    expect(canResumeInPlace('vieja', rows)).toBe(true)
    expect(canResumeInPlace('desconocida', rows)).toBe(true)
  })
})
