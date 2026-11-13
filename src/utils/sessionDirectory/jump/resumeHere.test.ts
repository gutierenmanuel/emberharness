import { describe, expect, test } from 'bun:test'
import { buildResumeArgs, resumeHere } from './resumeHere.js'
import type { SessionRow } from '../types.js'

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    key: 's1',
    self: false,
    harness: 'fnharness',
    origin: 'recent',
    status: 'done',
    title: 't',
    lastActivity: 0,
    actions: [],
    sessionId: 's1',
    cwd: '/work/proyecto',
    ...over,
  }
}

describe('buildResumeArgs', () => {
  test('reanudar: --resume y --chdir', () => {
    expect(buildResumeArgs(row(), 'resume')).toEqual(['--resume', 's1', '--chdir', '/work/proyecto'])
  })

  test('bifurcar: --fork-session justo despues del sessionId', () => {
    expect(buildResumeArgs(row(), 'fork')).toEqual(['--resume', 's1', '--fork-session', '--chdir', '/work/proyecto'])
  })

  test('cuenta claude: --account sin --model', () => {
    expect(buildResumeArgs(row({ account: 'claude', model: 'opus' }), 'resume')).toEqual([
      '--resume', 's1', '--chdir', '/work/proyecto', '--account', 'claude',
    ])
  })

  test('la cuenta "default" de una bg no se reenvía', () => {
    expect(buildResumeArgs(row({ account: 'default', model: 'm' }), 'resume')).toEqual(['--resume', 's1', '--chdir', '/work/proyecto'])
  })

  test('otra cuenta: --account y --model', () => {
    expect(buildResumeArgs(row({ account: 'twil', model: 'm8b' }), 'resume')).toEqual([
      '--resume', 's1', '--chdir', '/work/proyecto', '--account', 'twil', '--model', 'm8b',
    ])
  })

  test('sin cwd no hay --chdir; sin sessionId lanza', () => {
    expect(buildResumeArgs(row({ cwd: undefined }), 'resume')).toEqual(['--resume', 's1'])
    expect(() => buildResumeArgs(row({ sessionId: undefined }), 'resume')).toThrow()
  })
})

describe('resumeHere', () => {
  function deps(canRestart: boolean, rows?: SessionRow[]) {
    const calls: string[][] = []
    return {
      calls,
      d: {
        launcherCanRestart: () => canRestart,
        requestRestart: async (a: readonly string[]) => {
          calls.push([...a])
          return true
        },
        allRows: rows,
      },
    }
  }

  test('con lanzador pide el reinicio con los argumentos y devuelve ok', async () => {
    const { calls, d } = deps(true)
    const r = await resumeHere(row(), 'resume', d)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([['--resume', 's1', '--chdir', '/work/proyecto']])
  })

  test('sin lanzador devuelve el comando manual y no reinicia', async () => {
    const { calls, d } = deps(false)
    const r = await resumeHere(row(), 'fork', d)
    expect(r.ok).toBe(false)
    expect(r.manualCommand).toBe('fnharness --resume s1 --fork-session --chdir /work/proyecto')
    expect(r.message).toContain('./cli')
    expect(calls).toEqual([])
  })

  test('reanudar una sesion viva se rechaza; bifurcarla se permite', async () => {
    const viva = row({ pid: 4242, origin: 'kitty', status: 'idle' })
    const a = deps(true, [viva])
    const r = await resumeHere(viva, 'resume', a.d)
    expect(r.ok).toBe(false)
    expect(r.message).toBe('sigue viva: usa Bifurcar aqui')
    expect(a.calls).toEqual([])
    const b = deps(true, [viva])
    expect((await resumeHere(viva, 'fork', b.d)).ok).toBe(true)
    expect(b.calls).toHaveLength(1)
  })

  test('una conversacion de claude no cruza de arnes', async () => {
    const { calls, d } = deps(true)
    const r = await resumeHere(row({ harness: 'claude' }), 'fork', d)
    expect(r.ok).toBe(false)
    expect(r.message).toBe('una conversacion de claude no cruza de arnes')
    expect(calls).toEqual([])
  })

  test('si requestRestart devuelve false, cae al comando manual', async () => {
    const r = await resumeHere(row(), 'resume', { launcherCanRestart: () => true, requestRestart: async () => false })
    expect(r.ok).toBe(false)
    expect(r.manualCommand).toContain('--resume s1')
  })
})
