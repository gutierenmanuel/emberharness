import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionRow } from '../types.js'
import { focusKittyWindow, isKittyWindowFocused, kittyFocusCommand } from './kittyFocus.js'

let dir: string
let bin: string
let log: string
let ctl: string

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    key: 'k',
    self: false,
    harness: 'fnharness',
    origin: 'kitty',
    status: 'idle',
    title: 't',
    lastActivity: 0,
    actions: [],
    kitty: { listenOn: 'unix:/tmp/kitty-1', windowId: 7, focused: false },
    ...over,
  }
}

/** kitty falso: registra los argumentos; `ls` imprime JSON con is_focused según el fichero de control. */
function writeFakeKitty(): void {
  writeFileSync(
    bin,
    `#!/bin/bash
echo "$*" >> "${log}"
mode=$(cat "${ctl}" 2>/dev/null)
case "$*" in
  *focus-window*) [ "$mode" = "fail" ] && { echo "boom" >&2; exit 1; }; [ "$mode" = "hang" ] && sleep 5; exit 0 ;;
  *" ls") [ "$mode" = "lsfail" ] && exit 1
    f=false; [ "$mode" = "focused" ] && f=true
    echo '[{"id":1,"tabs":[{"windows":[{"id":3,"is_focused":true},{"id":7,"is_focused":'$f'}]}]}]' ;;
esac
`,
  )
  chmodSync(bin, 0o755)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kittyfocus-'))
  bin = join(dir, 'kitty')
  log = join(dir, 'args.log')
  ctl = join(dir, 'mode')
  writeFakeKitty()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup(mode: string): void {
  writeFileSync(ctl, mode)
  writeFileSync(log, '')
}

describe('focusKittyWindow', () => {
  test('ventana enfocada: ok y argumentos correctos', async () => {
    setup('focused')
    const r = await focusKittyWindow(row(), { kittyBin: bin, pollMs: 5 })
    expect(r.ok).toBe(true)
    expect(r.manualCommand).toBeUndefined()
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('@ --to unix:/tmp/kitty-1 focus-window --match id:7')
    expect(lines[1]).toBe('@ --to unix:/tmp/kitty-1 ls')
  })

  test('robo de foco: is_focused false da ok:false con comando manual', async () => {
    setup('stolen')
    const r = await focusKittyWindow(row(), { kittyBin: bin, pollMs: 5 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('no recibió el foco')
    expect(r.manualCommand).toBe(`${bin} @ --to unix:/tmp/kitty-1 focus-window --match id:7`)
  })

  test('focus-window falla: ok:false con stderr', async () => {
    setup('fail')
    const r = await focusKittyWindow(row(), { kittyBin: bin, pollMs: 5 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('boom')
    expect(r.manualCommand).toContain('focus-window --match id:7')
  })

  test('ls falla: ok:false', async () => {
    setup('lsfail')
    const r = await focusKittyWindow(row(), { kittyBin: bin, pollMs: 5 })
    expect(r.ok).toBe(false)
    expect(r.manualCommand).toBeDefined()
  })

  test('kitty ausente: ok:false', async () => {
    const r = await focusKittyWindow(row(), { kittyBin: join(dir, 'no-existe') })
    expect(r.ok).toBe(false)
    expect(r.manualCommand).toBeDefined()
  })

  test('timeout: ok:false sin esperar al proceso colgado', async () => {
    setup('hang')
    const t0 = Date.now()
    const r = await focusKittyWindow(row(), { kittyBin: bin, timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('sin respuesta')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('fila sin ventana de kitty', async () => {
    const r = await focusKittyWindow(row({ kitty: undefined }), { kittyBin: bin })
    expect(r).toEqual({ ok: false, message: 'esta sesión no tiene ventana de kitty' })
  })
})

describe('helpers puros', () => {
  test('isKittyWindowFocused', () => {
    const ls = JSON.stringify([{ tabs: [{ windows: [{ id: 1, is_focused: true }, { id: 2, is_focused: false }] }] }])
    expect(isKittyWindowFocused(ls, 1)).toBe(true)
    expect(isKittyWindowFocused(ls, 2)).toBe(false)
    expect(isKittyWindowFocused(ls, 9)).toBe(false)
    expect(isKittyWindowFocused('no json', 1)).toBe(false)
  })
  test('kittyFocusCommand', () => {
    expect(kittyFocusCommand('unix:/x', 4)).toBe('kitty @ --to unix:/x focus-window --match id:4')
  })
})
