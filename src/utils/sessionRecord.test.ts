import { describe, expect, test } from 'bun:test'
import { buildRecordOrigin } from './sessionRecord.js'

describe('buildRecordOrigin', () => {
  test('un entorno sin terminal conocida da un origen vacío', () => {
    expect(buildRecordOrigin({})).toEqual({})
    expect(buildRecordOrigin({ TERM: 'xterm-256color', HOME: '/h' })).toEqual({})
  })

  test('kitty: id de ventana numérico y socket de control', () => {
    expect(
      buildRecordOrigin({ KITTY_WINDOW_ID: '12', KITTY_LISTEN_ON: 'unix:/tmp/kitty-77' }),
    ).toEqual({ kittyWindowId: 12, kittyListenOn: 'unix:/tmp/kitty-77' })
  })

  test('un KITTY_WINDOW_ID que no es un número se descarta', () => {
    expect(buildRecordOrigin({ KITTY_WINDOW_ID: 'abc' })).toEqual({})
    expect(buildRecordOrigin({ KITTY_WINDOW_ID: '' })).toEqual({})
  })

  test('tmux: el socket es el nombre de fichero antes de la primera coma', () => {
    expect(
      buildRecordOrigin({ TMUX: '/tmp/tmux-1000/matrixterm,4242,3', TERM: 'tmux-256color' }),
    ).toEqual({ tmuxSocket: 'matrixterm' })
    expect(buildRecordOrigin({ TMUX: '/tmp/tmux-1000/default,1,0', TERM: 'screen' })).toEqual({
      tmuxSocket: 'default',
    })
  })

  test('tmux: sin TERM screen/tmux o sin TMUX no hay origen tmux', () => {
    expect(buildRecordOrigin({ TMUX: '/tmp/tmux-1000/x,1,0', TERM: 'xterm' })).toEqual({})
    expect(buildRecordOrigin({ TERM: 'tmux-256color' })).toEqual({})
  })

  test('la sesión tmux solo sale de CLAUDE_TERM_SESSION y solo dentro de tmux', () => {
    expect(
      buildRecordOrigin({ TMUX: '/t/s,1,0', TERM: 'screen', CLAUDE_TERM_SESSION: 'pc-a-c-1' }),
    ).toEqual({ tmuxSocket: 's', tmuxSession: 'pc-a-c-1' })
    expect(buildRecordOrigin({ CLAUDE_TERM_SESSION: 'suelta' })).toEqual({})
  })

  test('Element y el lanzador', () => {
    expect(
      buildRecordOrigin({
        MATRIX_TERMINAL_STATE_FILE: '/state/pc-a/x.json',
        FNHARNESS_LAUNCHER_PID: '9001',
      }),
    ).toEqual({ matrixStateFile: '/state/pc-a/x.json', launcherPid: 9001 })
  })

  test('todo junto y sin claves undefined', () => {
    const o = buildRecordOrigin({
      KITTY_WINDOW_ID: '3',
      TMUX: '/t/m,1,0',
      TERM: 'screen-256color',
    })
    expect(Object.keys(o).sort()).toEqual(['kittyWindowId', 'tmuxSocket'])
  })
})
