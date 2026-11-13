import { describe, expect, test } from 'bun:test'
import {
  ancestorChain,
  detectOrigin,
  findKittyWindow,
  findKittyWindowByRecord,
  tmuxSocketFromEnv,
} from './origin.js'
import type { KittyWindow, ProcInfo } from './types.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const kittyWindows: KittyWindow[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'kitty-windows.json'), 'utf8'),
)

describe('detectOrigin', () => {
  test('CLAUDE_TERM_SESSION es element y gana a todo', () => {
    const h = detectOrigin({
      env: { CLAUDE_TERM_SESSION: 'pc-a-c-1', TMUX: '/tmp/tmux-1000/matrixterm,1,0', TERM: 'tmux-256color' },
    })
    expect(h.origin).toBe('element')
    expect(h.tmuxSocket).toBe('matrixterm')
  })

  test('kind bg es bg; sdk y daemon son headless', () => {
    expect(detectOrigin({ env: {}, kind: 'bg' }).origin).toBe('bg')
    expect(detectOrigin({ env: {}, entrypoint: 'sdk-cli' }).origin).toBe('headless')
    expect(detectOrigin({ env: {}, entrypoint: 'sdk-ts' }).origin).toBe('headless')
    expect(detectOrigin({ env: {}, kind: 'daemon' }).origin).toBe('headless')
    expect(detectOrigin({ env: {}, kind: 'daemon-worker' }).origin).toBe('headless')
  })

  test('headless por sdk gana a kitty y tmux', () => {
    const h = detectOrigin({
      env: { KITTY_WINDOW_ID: '3', TMUX: '/tmp/tmux-1000/default,1,0', TERM: 'screen' },
      entrypoint: 'sdk-cli',
    })
    expect(h.origin).toBe('headless')
    expect(h.kittyCandidate).toBe(true)
  })

  test('tmux exige TMUX y TERM screen o tmux; extrae el socket', () => {
    const t = detectOrigin({ env: { TMUX: '/tmp/tmux-1000/matrixterm,3211,0', TERM: 'tmux-256color' } })
    expect(t.origin).toBe('tmux')
    expect(t.tmuxSocket).toBe('matrixterm')
    expect(detectOrigin({ env: { TMUX: '/tmp/tmux-1000/x,1,0', TERM: 'xterm-256color' } }).origin).toBeUndefined()
    expect(detectOrigin({ env: { TMUX: '/tmp/tmux-1000/x,1,0', TERM: 'screen-256color' } }).origin).toBe('tmux')
  })

  test('KITTY_WINDOW_ID solo da un candidato kitty', () => {
    const h = detectOrigin({ env: { KITTY_WINDOW_ID: '7', KITTY_LISTEN_ON: 'unix:/tmp/kitty-old' } })
    expect(h.origin).toBe('kitty')
    expect(h.kittyCandidate).toBe(true)
    expect(h.kittyWindowId).toBe(7)
    expect(h.kittyListenOn).toBe('unix:/tmp/kitty-old')
  })

  test('sin pistas no hay origen', () => {
    expect(detectOrigin({ env: {} })).toEqual({ origin: undefined, kittyCandidate: false })
  })

  test('tmuxSocketFromEnv', () => {
    expect(tmuxSocketFromEnv('/tmp/tmux-1000/default,100,2')).toBe('default')
    expect(tmuxSocketFromEnv('')).toBeUndefined()
    expect(tmuxSocketFromEnv(undefined)).toBeUndefined()
  })
})

describe('findKittyWindow', () => {
  const procs: Record<number, ProcInfo> = {
    1061307: { ppid: 1061250, env: {} },
    1061250: { ppid: 1061200, env: {} },
    1061200: { ppid: 1, env: {} },
  }

  test('sube por los ancestros hasta el pid de la ventana', () => {
    // sesion -> padre -> shell (pid de la ventana 3)
    const w = findKittyWindow(1061307, { ...procs, 1061307: { ppid: 1061250, env: {} } }, [
      { ...kittyWindows[0]!, foregroundPids: [] },
    ])
    expect(w?.windowId).toBe(3)
  })

  test('también casa por foregroundPids', () => {
    expect(findKittyWindow(1061307, procs, kittyWindows)?.windowId).toBe(3)
  })

  test('sin ventana que lo confirme devuelve undefined', () => {
    expect(findKittyWindow(1061307, procs, [kittyWindows[1]!])).toBeUndefined()
    expect(findKittyWindow(1061307, procs, [])).toBeUndefined()
  })

  test('un ciclo de padres no cuelga la búsqueda', () => {
    const cyc: Record<number, ProcInfo> = { 10: { ppid: 11, env: {} }, 11: { ppid: 10, env: {} } }
    expect(ancestorChain(10, cyc)).toEqual([10, 11])
    expect(findKittyWindow(10, cyc, kittyWindows)).toBeUndefined()
  })

  test('tope de 64 saltos', () => {
    const long: Record<number, ProcInfo> = {}
    for (let i = 1; i < 200; i++) long[i] = { ppid: i + 1, env: {} }
    expect(ancestorChain(1, long).length).toBeLessThanOrEqual(65)
    const win: KittyWindow = { ...kittyWindows[0]!, pid: 150, foregroundPids: [] }
    expect(findKittyWindow(1, long, [win])).toBeUndefined()
  })

  test('findKittyWindowByRecord exige id y listenOn vivos', () => {
    expect(findKittyWindowByRecord({ kittyWindowId: 4, kittyListenOn: 'unix:/tmp/kitty-1000' }, kittyWindows)?.pid).toBe(1070000)
    expect(findKittyWindowByRecord({ kittyWindowId: 4, kittyListenOn: 'unix:/tmp/kitty-old' }, kittyWindows)).toBeUndefined()
    expect(findKittyWindowByRecord({ kittyWindowId: 4 }, kittyWindows)).toBeUndefined()
    expect(findKittyWindowByRecord(undefined, kittyWindows)).toBeUndefined()
  })
})
