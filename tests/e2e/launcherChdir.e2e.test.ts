/**
 * `--chdir <dir>` en el bucle de reinicio de bin/fnharness: lo consume el lanzador (hace `cd`
 * antes de relanzar el CLI) y no llega al CLI; un directorio inexistente se ignora con un aviso.
 * Se prueba con un ./cli falso en una copia del lanzador.
 */

import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_DIR } from './harness.js'

function fakeApp(cliScript: string) {
  const app = mkdtempSync(join(tmpdir(), 'fnh-chdir-'))
  mkdirSync(join(app, 'bin'))
  copyFileSync(join(APP_DIR, 'bin', 'fnharness'), join(app, 'bin', 'fnharness'))
  chmodSync(join(app, 'bin', 'fnharness'), 0o755)
  writeFileSync(join(app, 'cli'), `#!/usr/bin/env bash\nLOG="$(dirname "$0")/log.txt"\n${cliScript}\n`)
  chmodSync(join(app, 'cli'), 0o755)
  const config = mkdtempSync(join(tmpdir(), 'fnh-chdir-cfg-'))
  return { app, config, log: join(app, 'log.txt'), launcher: join(app, 'bin', 'fnharness') }
}

function baseEnv(config: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of ['FNHARNESS_NO_RESTART', 'FNHARNESS_LAUNCHER_PID', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_MODEL']) delete env[k]
  return { ...env, CLAUDE_CONFIG_DIR: config, FNHARNESS_NO_BYPASS: '1', TMUX: '' }
}

const readLog = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : [])

/** ./cli falso: la primera vez pide reiniciar con `restartArgs`; la segunda registra pwd y argumentos. */
function cliThatRestarts(restartArgs: string[]) {
  const quoted = restartArgs.map(a => `'${a}'`).join(' ')
  return `
if [[ ! -f "$(dirname "$0")/ya" ]]; then
  touch "$(dirname "$0")/ya"
  mkdir -p "$CLAUDE_CONFIG_DIR/restart"
  printf '%s\\n' ${quoted} > "$CLAUDE_CONFIG_DIR/restart/$FNHARNESS_LAUNCHER_PID.args"
  exit 75
fi
echo "pwd=$(pwd -P) args=$*" >> "$LOG"
exit 3
`
}

describe('bin/fnharness --chdir', () => {
  test('el CLI relanzado arranca en el directorio y no recibe --chdir', async () => {
    const dir2 = realpathSync(mkdtempSync(join(tmpdir(), 'fnh-chdir-dir2-')))
    const a = fakeApp(cliThatRestarts(['--resume', 'sid-1', '--chdir', dir2, '--fork-session']))
    const proc = Bun.spawn([a.launcher], { env: baseEnv(a.config), cwd: tmpdir(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(await proc.exited).toBe(3)
    expect(readLog(a.log)).toEqual([`pwd=${dir2} args=--resume sid-1 --fork-session`])
  }, 40_000)

  test('un directorio inexistente se ignora con aviso y el bucle sigue', async () => {
    const origen = realpathSync(mkdtempSync(join(tmpdir(), 'fnh-chdir-origen-')))
    const a = fakeApp(cliThatRestarts(['--resume', 'sid-1', '--chdir', '/no/existe/jamas', '--fork-session']))
    const proc = Bun.spawn([a.launcher], { env: baseEnv(a.config), cwd: origen, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    expect(await proc.exited).toBe(3)
    expect(readLog(a.log)).toEqual([`pwd=${origen} args=--resume sid-1 --fork-session`])
    expect(await new Response(proc.stderr).text()).toContain('--chdir ignorado')
  }, 40_000)
})
