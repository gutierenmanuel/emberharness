/**
 * Bucle de reinicio del lanzador bin/fnharness (perfiles): con el código 75 y el fichero
 * restart/<pid>.args relanza el CLI con esos argumentos, reenvía SIGTERM al hijo, deja
 * pasar la entrada estándar y con -p sustituye al lanzador sin bucle. Se prueba con un
 * ./cli falso (un script) en una copia del lanzador, sin compilar nada ni tocar ningún proveedor.
 */

import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_DIR } from './harness.js'

/** App falsa: bin/fnharness real + un ./cli que ejecuta `cliScript` (con $LOG apuntando a log.txt). */
function fakeApp(cliScript: string) {
  const app = mkdtempSync(join(tmpdir(), 'fnh-launcher-'))
  mkdirSync(join(app, 'bin'))
  copyFileSync(join(APP_DIR, 'bin', 'fnharness'), join(app, 'bin', 'fnharness'))
  chmodSync(join(app, 'bin', 'fnharness'), 0o755)
  writeFileSync(join(app, 'cli'), `#!/usr/bin/env bash\nLOG="$(dirname "$0")/log.txt"\n${cliScript}\n`)
  chmodSync(join(app, 'cli'), 0o755)
  const config = mkdtempSync(join(tmpdir(), 'fnh-launcher-cfg-'))
  return { app, config, log: join(app, 'log.txt'), launcher: join(app, 'bin', 'fnharness') }
}

function baseEnv(config: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of ['FNHARNESS_NO_RESTART', 'FNHARNESS_LAUNCHER_PID', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_MODEL']) delete env[k]
  return { ...env, CLAUDE_CONFIG_DIR: config, FNHARNESS_NO_BYPASS: '1', TMUX: '' }
}

const readLog = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : [])

describe('bin/fnharness reinicio', () => {
  test('código 75 con fichero: relanza con --resume/--perfil y reaplica --account y --model', async () => {
    const a = fakeApp(`
echo "args=$* account=\${CLAUDE_MULTIMODEL_ACCOUNT:-} model=\${CLAUDE_MULTIMODEL_MODEL:-}" >> "$LOG"
if [[ -z "\${FNHARNESS_LAUNCHER_PID:-}" ]]; then echo "sin pid" >> "$LOG"; exit 9; fi
if [[ "$(wc -l < "$LOG")" -eq 1 ]]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/restart"
  printf '%s\\n' --resume sess-1 --perfil minimo --account twil --model m8b > "$CLAUDE_CONFIG_DIR/restart/$FNHARNESS_LAUNCHER_PID.args"
  exit 75
fi
exit 3
`)
    const proc = Bun.spawn([a.launcher, '--perfil', 'full', '--account', 'claude'], {
      env: baseEnv(a.config),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    })
    expect(await proc.exited).toBe(3)
    const log = readLog(a.log)
    expect(log).toHaveLength(2)
    expect(log[0]).toBe('args=--perfil full account=claude model=')
    expect(log[1]).toBe('args=--perfil minimo --resume sess-1 account=twil model=m8b')
    expect(existsSync(join(a.config, 'restart', 'x.args'))).toBe(false)
  }, 40_000)

  test('código 75 sin fichero o cualquier otro código: termina con ese código', async () => {
    const a = fakeApp(`echo run >> "$LOG"; exit 75`)
    const proc = Bun.spawn([a.launcher], { env: baseEnv(a.config), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(await proc.exited).toBe(75)
    expect(readLog(a.log)).toEqual(['run'])
  }, 40_000)

  test('con -p no hay bucle: el CLI sustituye al lanzador, sin FNHARNESS_LAUNCHER_PID, y --perfil se reenvía', async () => {
    const a = fakeApp(`echo "args=$* pid=\${FNHARNESS_LAUNCHER_PID:-none}" >> "$LOG"; exit 4`)
    const proc = Bun.spawn([a.launcher, '--perfil=simple', '-p', 'hola'], { env: baseEnv(a.config), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(await proc.exited).toBe(4)
    expect(readLog(a.log)).toEqual(['args=--perfil simple -p hola pid=none'])
  }, 40_000)

  test('FNHARNESS_NO_RESTART=1 tampoco hace bucle', async () => {
    const a = fakeApp(`echo "pid=\${FNHARNESS_LAUNCHER_PID:-none}" >> "$LOG"; exit 0`)
    const proc = Bun.spawn([a.launcher], { env: { ...baseEnv(a.config), FNHARNESS_NO_RESTART: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(await proc.exited).toBe(0)
    expect(readLog(a.log)).toEqual(['pid=none'])
  }, 40_000)

  test('la entrada estándar llega al CLI aunque corra en segundo plano', async () => {
    const a = fakeApp(`cat >> "$LOG"; exit 0`)
    const proc = Bun.spawn([a.launcher], { env: baseEnv(a.config), stdin: new Blob(['texto por stdin\n']), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(await proc.exited).toBe(0)
    expect(readLog(a.log)).toEqual(['texto por stdin'])
  }, 40_000)

  test('SIGTERM al lanzador se reenvía al CLI', async () => {
    const a = fakeApp(`
trap 'echo "hijo recibe TERM" >> "$LOG"; exit 143' TERM
echo listo >> "$LOG"
while true; do sleep 0.1; done
`)
    const proc = Bun.spawn([a.launcher], { env: baseEnv(a.config), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    for (let i = 0; i < 100 && !readLog(a.log).includes('listo'); i++) await Bun.sleep(50)
    expect(readLog(a.log)).toContain('listo')
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(143)
    expect(readLog(a.log)).toContain('hijo recibe TERM')
  }, 40_000)
})
