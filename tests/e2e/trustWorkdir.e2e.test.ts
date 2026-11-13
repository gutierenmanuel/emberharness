/**
 * --trust-workdir <dir> end to end (docs/trust_workdir.md): an unattended
 * session (a Matrix room in tmux) must reach its input box without anybody
 * answering the workspace trust dialog, and a human session must still see it.
 * Real ./cli in a pseudo-terminal, throwaway CLAUDE_CONFIG_DIR, cwd never trusted
 * before, fake OpenAI backend.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_DIR, CLI, fakeEnv, hasCli, startFakeOpenAI } from './harness.js'
import { startTui } from './tui.js'

let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI('hola')
})
afterAll(() => fake.stop())

const DIALOG = 'Yes, I trust this folder'

/** Onboarding done, bypass warning NOT accepted, and no project ever trusted. */
function freshSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'fnh-trust-'))
  const configDir = join(root, 'config')
  const cwd = join(root, 'work')
  mkdirSync(configDir)
  mkdirSync(cwd)
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }))
  return { root, configDir, cwd, events: join(root, 'events.jsonl') }
}

const trusted = (configDir: string, cwd: string): boolean =>
  JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')).projects?.[cwd]?.hasTrustDialogAccepted === true

const eventTypes = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.startsWith('{'))
        .map(l => JSON.parse(l).type)
    : []

async function waitType(file: string, type: string, timeoutMs: number): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (eventTypes(file).includes(type)) return Date.now() - t0
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`no ${type} event in ${timeoutMs} ms; got ${JSON.stringify(eventTypes(file))}`)
}

describe.skipIf(!hasCli)('--trust-workdir e2e', () => {
  test('without the flag a never-trusted folder shows the trust dialog and nothing is persisted', async () => {
    const { configDir, cwd, events } = freshSandbox()
    const tui = startTui(fakeEnv(fake.baseUrl, configDir, { FNHARNESS_EVENTS: events }), cwd, 140, `${CLI} --dangerously-skip-permissions`)
    try {
      await tui.waitFor(DIALOG, 30_000)
      expect(tui.text()).toContain('Accessing workspace')
      expect(eventTypes(events)).not.toContain('session_start')
      expect(trusted(configDir, cwd)).toBe(false)
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('with --trust-workdir <cwd> there is no dialog, the folder is trusted and session_start arrives in < 5 s', async () => {
    const { configDir, cwd, events } = freshSandbox()
    const tui = startTui(
      fakeEnv(fake.baseUrl, configDir, { FNHARNESS_EVENTS: events }),
      cwd,
      140,
      `${CLI} --dangerously-skip-permissions --trust-workdir ${cwd}`,
    )
    try {
      let ms = 0
      try {
        ms = await waitType(events, 'session_start', 20_000)
      } catch (e) {
        throw new Error(`${e}\n--- tui tail ---\n${tui.text().slice(-1500)}`)
      }
      expect(ms).toBeLessThan(5_000)
      await waitType(events, 'ready', 20_000)
      expect(tui.text()).not.toContain(DIALOG)
      expect(tui.text()).not.toContain('Bypass Permissions mode') // warning answered for this session only
      expect(trusted(configDir, cwd)).toBe(true)
      // The session-only answers are not persisted.
      const settings = join(configDir, 'settings.json')
      expect(!existsSync(settings) || !readFileSync(settings, 'utf8').includes('skipDangerousModePermissionPrompt')).toBe(true)
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('--trust-workdir pointing to another folder is ignored: the dialog stays', async () => {
    const { root, configDir, cwd, events } = freshSandbox()
    const other = join(root, 'other')
    mkdirSync(other)
    const tui = startTui(
      fakeEnv(fake.baseUrl, configDir, { FNHARNESS_EVENTS: events }),
      cwd,
      140,
      `${CLI} --dangerously-skip-permissions --trust-workdir ${other}`,
    )
    try {
      await tui.waitFor(DIALOG, 30_000)
      expect(trusted(configDir, cwd)).toBe(false)
      expect(trusted(configDir, other)).toBe(false)
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('an environment variable does not trust anything', async () => {
    const { configDir, cwd, events } = freshSandbox()
    const tui = startTui(
      fakeEnv(fake.baseUrl, configDir, { FNHARNESS_EVENTS: events, FNHARNESS_TRUST_WORKDIR: cwd, CLAUDE_TRUST_WORKDIR: cwd }),
      cwd,
      140,
      `${CLI} --dangerously-skip-permissions`,
    )
    try {
      await tui.waitFor(DIALOG, 30_000)
      expect(trusted(configDir, cwd)).toBe(false)
    } finally {
      await tui.stop()
    }
  }, 60_000)
})

describe('bin/fnharness forwards --trust-workdir', () => {
  test('to the CLI at start and again after a /perfil restart, which replaces the session arguments', async () => {
    const app = mkdtempSync(join(tmpdir(), 'fnh-trustbin-'))
    mkdirSync(join(app, 'bin'))
    copyFileSync(join(APP_DIR, 'bin', 'fnharness'), join(app, 'bin', 'fnharness'))
    chmodSync(join(app, 'bin', 'fnharness'), 0o755)
    // Fake CLI: first run logs its args and asks for a restart; the second logs and exits.
    writeFileSync(
      join(app, 'cli'),
      `#!/usr/bin/env bash
LOG="$(dirname "$0")/log.txt"
echo "args=$*" >> "$LOG"
if [[ ! -f "$(dirname "$0")/ya" ]]; then
  touch "$(dirname "$0")/ya"
  mkdir -p "$CLAUDE_CONFIG_DIR/restart"
  printf '%s\\n' --resume sid-1 > "$CLAUDE_CONFIG_DIR/restart/$FNHARNESS_LAUNCHER_PID.args"
  exit 75
fi
exit 3
`,
    )
    chmodSync(join(app, 'cli'), 0o755)
    const config = mkdtempSync(join(tmpdir(), 'fnh-trustbin-cfg-'))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    for (const k of ['FNHARNESS_NO_RESTART', 'FNHARNESS_LAUNCHER_PID', 'CLAUDE_MULTIMODEL_ACCOUNT']) delete env[k]
    const proc = Bun.spawn(
      [join(app, 'bin', 'fnharness'), '--dangerously-skip-permissions', '--trust-workdir', '/x/sala', '--session-id', 'abc'],
      { env: { ...env, CLAUDE_CONFIG_DIR: config, FNHARNESS_NO_BYPASS: '1', TMUX: '' }, cwd: tmpdir(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    )
    expect(await proc.exited).toBe(3)
    const log = readFileSync(join(app, 'log.txt'), 'utf8').trim().split('\n')
    expect(log[0]).toBe('args=--trust-workdir /x/sala --dangerously-skip-permissions --session-id abc')
    expect(log[1]).toBe('args=--trust-workdir /x/sala --resume sid-1')
  }, 40_000)
})
