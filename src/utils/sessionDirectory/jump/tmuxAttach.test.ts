import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionRow } from '../types.js'
import { attachNotice, attachTmux, buildAttachArgs } from './tmuxAttach.js'

let dir: string
let bin: string
let log: string

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    key: 'k',
    self: false,
    harness: 'fnharness',
    origin: 'tmux',
    status: 'idle',
    title: 't',
    lastActivity: 0,
    actions: [],
    tmux: { socket: 'matrixterm', session: 'eni-1' },
    ...over,
  }
}

/** tmux falso: registra argumentos y el valor de TMUX; `attach` sale con el código de FAKE_ATTACH_EXIT. */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tmuxattach-'))
  bin = join(dir, 'tmux')
  log = join(dir, 'log')
  writeFileSync(
    bin,
    `#!/bin/bash
echo "tmux $* TMUX=[\${TMUX-unset}] PANE=[\${TMUX_PANE-unset}]" >> "${log}"
case "$*" in
  *has-session*) [ -n "$FAKE_NO_SESSION" ] && { echo "can't find session" >&2; exit 1; }; exit 0 ;;
  *attach*) exit \${FAKE_ATTACH_EXIT:-0} ;;
esac
`,
  )
  chmodSync(bin, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function hooksWithLog(extraEnv: NodeJS.ProcessEnv = {}) {
  writeFileSync(log, '')
  return {
    tmuxBin: bin,
    env: { ...process.env, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3', ...extraEnv },
    suspend: () => writeFileSync(log, readFileSync(log, 'utf8') + 'SUSPEND\n'),
    resume: () => writeFileSync(log, readFileSync(log, 'utf8') + 'RESUME\n'),
  }
}

describe('buildAttachArgs', () => {
  test('socket y sesión', () => {
    expect(buildAttachArgs(row())).toEqual(['-L', 'matrixterm', 'attach', '-f', 'ignore-size', '-t', 'eni-1'])
  })
  test('socket default o vacío omite -L', () => {
    expect(buildAttachArgs(row({ tmux: { socket: 'default', session: 's' } }))).toEqual(['attach', '-f', 'ignore-size', '-t', 's'])
    expect(buildAttachArgs(row({ tmux: { socket: '', session: 's' } }))).toEqual(['attach', '-f', 'ignore-size', '-t', 's'])
  })
  test('sin sesión lanza error', () => {
    expect(() => buildAttachArgs(row({ tmux: { socket: 'x', session: '' } }))).toThrow()
    expect(() => buildAttachArgs(row({ tmux: undefined }))).toThrow()
  })
})

describe('attachNotice', () => {
  test('aviso solo para element', () => {
    expect(attachNotice(row({ origin: 'element' }))).toBe('Vas a escribir en la misma TUI que el puente de Matrix; C-b d para volver')
    expect(attachNotice(row({ origin: 'tmux' }))).toBeUndefined()
  })
})

describe('attachTmux', () => {
  test('ok: suspend, attach y resume en orden, sin TMUX en el hijo', async () => {
    const h = hooksWithLog({ FAKE_ATTACH_EXIT: '0' })
    const r = await attachTmux(row(), h)
    expect(r.ok).toBe(true)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    const iSusp = lines.indexOf('SUSPEND')
    const iAttach = lines.findIndex(l => l.includes(' attach '))
    const iResume = lines.indexOf('RESUME')
    expect(iSusp).toBeGreaterThanOrEqual(0)
    expect(iSusp).toBeLessThan(iAttach)
    expect(iAttach).toBeLessThan(iResume)
    expect(lines[iAttach]).toContain('-L matrixterm attach -f ignore-size -t eni-1')
    for (const l of lines.filter(l => l.startsWith('tmux'))) {
      expect(l).toContain('TMUX=[unset]')
      expect(l).toContain('PANE=[unset]')
    }
  })

  test('tmux sale con código 1: ok:false y resume igualmente', async () => {
    const h = hooksWithLog({ FAKE_ATTACH_EXIT: '1' })
    const r = await attachTmux(row(), h)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('código 1')
    expect(readFileSync(log, 'utf8')).toContain('RESUME')
  })

  test('sesión inexistente: ok:false sin suspender la UI', async () => {
    const h = hooksWithLog({ FAKE_NO_SESSION: '1' })
    const r = await attachTmux(row(), h)
    expect(r.ok).toBe(false)
    expect(r.message).toContain("can't find session")
    const text = readFileSync(log, 'utf8')
    expect(text).not.toContain('SUSPEND')
    expect(text).not.toContain('RESUME')
  })

  test('tmux ausente: ok:false', async () => {
    const h = hooksWithLog()
    const r = await attachTmux(row(), { ...h, tmuxBin: join(dir, 'no-existe') })
    expect(r.ok).toBe(false)
  })

  test('fila sin sesión tmux', async () => {
    const r = await attachTmux(row({ tmux: undefined }), hooksWithLog())
    expect(r.ok).toBe(false)
    expect(r.message).toContain('no tiene sesión tmux')
  })
})

describe('con un servidor tmux real', () => {
  const sock = `fnh-test-${Math.random().toString(36).slice(2, 8)}`
  afterAll(() => {
    Bun.spawnSync(['tmux', '-L', sock, 'kill-server'])
  })

  test('buildAttachArgs apunta al servidor propio', () => {
    const created = Bun.spawnSync(['tmux', '-L', sock, 'new', '-d', '-s', 's1', 'sleep 60'])
    expect(created.exitCode).toBe(0)
    const args = buildAttachArgs(row({ tmux: { socket: sock, session: 's1' } }))
    expect(args.slice(0, 2)).toEqual(['-L', sock])
    // El mismo -L / -t resuelve a una sesión viva (sin adjuntar).
    const has = Bun.spawnSync(['tmux', '-L', args[1]!, 'has-session', '-t', args[args.length - 1]!])
    expect(has.exitCode).toBe(0)
  })
})
