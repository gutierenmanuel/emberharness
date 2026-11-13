/**
 * Directorio de sesiones de toda la máquina (`/sesiones`), contra el ./cli real
 * y con HOME aislado. Caso 1: tres sesiones de origen distinto conviven y se
 * listan sin duplicados desde otro proceso.
 *
 *  - una sesión fnharness headless real y viva (entrypoint sdk-*, origen headless);
 *  - un registro estilo Claude Code en `$HOME/.claude/sessions/<pid>.json` de un
 *    proceso real vivo (`exec -a fake-claude sleep`) cuyo ancestro es el proceso
 *    del test, que un `kitty` FALSO anuncia como ventana de kitty;
 *  - una sala de Element falsa (`MATRIX_TERMINALS_STATE_DIR`) sobre una sesión
 *    tmux real en un servidor propio.
 *
 * Nada de esto toca el display real ni los registros reales de la persona.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { CLI, hasCli, makeSandbox } from './harness.js'

type Row = {
  key: string
  self: boolean
  harness: string
  origin: string
  status: string
  title: string
  cwd?: string
  account?: string
  model?: string
  pid?: number
  sessionId?: string
  kitty?: { listenOn: string; windowId: number; focused: boolean }
  tmux?: { socket: string; session: string }
  room?: string
  actions: string[]
}

type Sse = { text: string }

function sse(model: string, delta: object, finish: string): string {
  const chunk = (d: object, f: string | null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`
  return (
    chunk({ role: 'assistant' }, null) +
    chunk(delta, null) +
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

/** Backend OpenAI falso mínimo: la sesión headless solo necesita existir. */
function fakeServer(model: string, reply: Sse) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      return new Response(sse(model, { content: reply.text }, 'stop'), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

async function waitFor(fn: () => boolean, ms = 30_000) {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await Bun.sleep(100)
  return fn()
}

async function sh(cmd: string[], env?: Record<string, string | undefined>): Promise<string> {
  const p = Bun.spawn(cmd, { env: env ?? process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}

const backend = fakeServer('model-a', { text: 'ok' })
const rand = Math.random().toString(36).slice(2, 8)
const TMUX_SOCKET = `fnh-e2e-${rand}`
const TMUX_SESSION = `eni-e2e-${rand}`
const KITTY_WINDOW_ID = 7
const ELEMENT_SESSION_ID = '11111111-2222-4333-8444-555555555555'
const CLAUDE_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'

let configDir = ''
let home = ''
let workDir = ''
let scratch = ''
let env: Record<string, string | undefined> = {}
let sessionA: ReturnType<typeof Bun.spawn> | undefined
let fakeClaude: ReturnType<typeof Bun.spawn> | undefined
let kittySock: Server | undefined
let kittyLog = ''
let kittySockPath = ''

beforeAll(async () => {
  if (!hasCli) return
  const sb = makeSandbox()
  configDir = sb.configDir
  workDir = sb.cwd
  home = dirname(configDir) // HOME aislado: el config dir cuelga de él
  scratch = mkdtempSync(join(tmpdir(), 'fnh-ss-'))
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ active: 'accta', accounts: { accta: { provider: 'custom', baseUrl: backend.baseUrl, model: 'model-a' } } }),
  )

  // (c) tmux real en un servidor propio + estado de Element falso.
  await sh(['tmux', '-L', TMUX_SOCKET, 'new', '-d', '-s', TMUX_SESSION, 'printf MARCA; cat'])
  const stateDir = join(scratch, 'matrix_terminals')
  mkdirSync(join(stateDir, 'eni-e2e'), { recursive: true })
  writeFileSync(
    join(stateDir, 'eni-e2e', `${TMUX_SESSION}.json`),
    JSON.stringify({
      profile: 'eni-e2e',
      session_id: ELEMENT_SESSION_ID,
      workdir: workDir,
      config_dir: configDir,
      socket: TMUX_SOCKET,
      session: TMUX_SESSION,
      started_at: '2026-11-13T10:00:00Z',
    }),
  )
  writeFileSync(
    join(stateDir, 'eni-e2e', 'conversations-eni-e2e.json'),
    JSON.stringify({
      space_id: '!space',
      conversations: [
        { room_id: '!room-viva', session: TMUX_SESSION, title: 'Sala de prueba E2E', claude_session_id: ELEMENT_SESSION_ID, workdir: workDir, status: 'active', created: '2026-11-13T10:00:00Z', last_activity: '2026-11-13T10:05:00Z' },
        { room_id: '!room-dormida', session: 'eni-e2e-dormida', title: 'Conversación dormida', claude_session_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', workdir: workDir, status: 'suspended', created: '2026-11-12T10:00:00Z', last_activity: '2026-11-12T10:05:00Z' },
      ],
    }),
  )

  // (d) kitty FALSO: anuncia una ventana cuyo pid es el de este proceso y deja constancia de cada llamada.
  const kittyDir = join(scratch, 'ksock')
  mkdirSync(kittyDir)
  kittySockPath = join(kittyDir, 'kitty-1')
  kittySock = createServer().listen(kittySockPath)
  await new Promise<void>(r => kittySock!.once('listening', () => r()))

  // (b) proceso vivo con un registro de Claude Code; su cmdline debe parecer de claude para que el
  // fundidor no lo descarte por reutilización de pid. El padre es este proceso.
  fakeClaude = Bun.spawn(['bash', '-c', 'exec -a fake-claude sleep 300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const claudeSessions = join(home, '.claude', 'sessions')
  mkdirSync(claudeSessions, { recursive: true })
  writeFileSync(
    join(claudeSessions, `${fakeClaude.pid}.json`),
    JSON.stringify({
      pid: fakeClaude.pid,
      sessionId: CLAUDE_SESSION_ID,
      cwd: workDir,
      startedAt: Date.now() - 60_000,
      kind: 'interactive',
      entrypoint: 'cli',
      version: '2.1.0',
      peerProtocol: 1,
      status: 'busy',
      updatedAt: Date.now() - 5_000,
    }),
  )

  const kittyJson = join(scratch, 'kitty-ls.json')
  kittyLog = join(scratch, 'kitty.log')
  writeFileSync(
    kittyJson,
    JSON.stringify([
      {
        id: 1,
        is_focused: true,
        tabs: [
          {
            id: 1,
            windows: [
              {
                id: KITTY_WINDOW_ID,
                pid: process.pid,
                cwd: workDir,
                title: 'ventana falsa',
                is_focused: true,
                foreground_processes: [{ pid: fakeClaude.pid, cmdline: ['fake-claude'] }],
              },
            ],
          },
        ],
      },
    ]),
  )
  const binDir = join(scratch, 'bin')
  mkdirSync(binDir)
  writeFileSync(
    join(binDir, 'kitty'),
    `#!/bin/sh\necho "$@" >> '${kittyLog}'\ncase " $* " in *" ls "*) cat '${kittyJson}';; esac\n`,
  )
  chmodSync(join(binDir, 'kitty'), 0o755)

  // Entorno de las sesiones: HOME aislado, nada de terminal heredada y el kitty falso delante en el PATH.
  env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    FNHARNESS_DISABLE_MODELS_FETCH: '1',
    FNHARNESS_CONTEXT_PROFILE: 'full',
    MATRIX_TERMINALS_STATE_DIR: stateDir,
    FNHARNESS_KITTY_SOCKET_DIR: kittyDir,
    PATH: `${binDir}:${process.env.PATH}`,
  }
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k]
  for (const k of [
    'CLAUDE_MULTIMODEL_PROVIDER', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_BASE_URL', 'CLAUDE_MULTIMODEL_MODEL',
    'FNHARNESS_ACCOUNT', 'ANTHROPIC_MODEL', 'TMUX', 'TMUX_PANE', 'CLAUDE_TERM_SESSION', 'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON',
    'MATRIX_TERMINAL_STATE_FILE', 'FNHARNESS_LAUNCHER_PID',
  ]) delete env[k]

  // (a) sesión fnharness headless real que sigue viva esperando entrada.
  sessionA = Bun.spawn([CLI, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
    cwd: workDir,
    env,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const pidFile = join(configDir, 'sessions', `${sessionA.pid}.json`)
  const registered = () => {
    try {
      return Boolean((JSON.parse(readFileSync(pidFile, 'utf8')) as { sessionId?: string }).sessionId)
    } catch {
      return false
    }
  }
  expect(await waitFor(registered)).toBe(true)
}, 60_000)

afterAll(async () => {
  sessionA?.kill()
  fakeClaude?.kill()
  await Promise.all([sessionA?.exited, fakeClaude?.exited])
  if (scratch) await sh(['tmux', '-L', TMUX_SOCKET, 'kill-server'])
  kittySock?.close()
  backend.stop()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

async function runCli(prompt: string) {
  const t0 = performance.now()
  const p = Bun.spawn([CLI, '-p', prompt], { cwd: workDir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  return { out, err, ms: performance.now() - t0 }
}

describe.skipIf(!hasCli)('sessionSwitcher e2e', () => {
  test('la sesión tmux del servidor propio existe de verdad', async () => {
    const pane = await sh(['tmux', '-L', TMUX_SOCKET, 'capture-pane', '-p', '-t', TMUX_SESSION])
    expect(pane).toContain('MARCA')
  })

  test('/sesiones list --json devuelve las tres sesiones con su origen, sin duplicados', async () => {
    const r = await runCli('/sesiones list --json')
    if (!r.out.trim().startsWith('[')) console.error('stdout:', r.out.slice(0, 2000), '\nstderr:', r.err.slice(0, 2000))
    const rows = JSON.parse(r.out.trim()) as Row[]

    // Sin duplicados: ni claves, ni pids, ni sessionIds repetidos.
    const keys = rows.map(x => x.key)
    expect(new Set(keys).size).toBe(keys.length)
    const pids = rows.flatMap(x => (x.pid !== undefined ? [x.pid] : []))
    expect(new Set(pids).size).toBe(pids.length)

    // Las otras sesiones (la propia de este `-p` y los transcripts cerrados no cuentan).
    const live = rows.filter(x => !x.self && x.origin !== 'recent')
    expect(live.map(x => x.origin).sort()).toEqual(['element', 'headless', 'kitty'])

    const headless = live.find(x => x.origin === 'headless')!
    expect(headless.harness).toBe('fnharness')
    expect(headless.pid).toBe(sessionA!.pid)
    expect(headless.account).toBe('accta')

    const kitty = live.find(x => x.origin === 'kitty')!
    expect(kitty.harness).toBe('claude')
    expect(kitty.pid).toBe(fakeClaude!.pid)
    expect(kitty.sessionId).toBe(CLAUDE_SESSION_ID)
    expect(kitty.status).toBe('busy')
    expect(kitty.kitty).toEqual({ listenOn: `unix:${kittySockPath}`, windowId: KITTY_WINDOW_ID, focused: true })

    const element = live.find(x => x.origin === 'element')!
    expect(element.tmux).toEqual({ socket: TMUX_SOCKET, session: TMUX_SESSION })
    expect(element.room).toBe('!room-viva')
    expect(element.title).toContain('Sala de prueba E2E')

    // El kitty falso se consultó con el socket y el subcomando esperados.
    expect(existsSync(kittyLog)).toBe(true)
    expect(readFileSync(kittyLog, 'utf8')).toContain(`@ --to unix:${kittySockPath} ls`)

    // El descubrimiento es rápido: el CLI entero (arranque incluido) cabe con holgura en 3 s.
    expect(r.ms).toBeLessThan(3000)
  }, 60_000)

  test('/sesiones sin --json imprime una línea por sesión con origen, estado y la actual marcada', async () => {
    const r = await runCli('/sesiones')
    const lines = r.out.split('\n').filter(l => l.trim() !== '')
    const find = (re: RegExp) => lines.find(l => re.test(l))
    expect(find(/^\*/)).toBeDefined() // la sesión actual lleva marca
    const kittyLine = find(/kitty\s+busy/)
    expect(kittyLine).toBeDefined()
    expect(kittyLine).toContain(workDir)
    expect(find(/element\s+\S+\s+.*Sala de prueba E2E/)).toBeDefined()
    expect(find(/head\s+\S+/)).toBeDefined()
    // Sin --todas no salen las conversaciones suspendidas.
    expect(r.out).not.toContain('Conversación dormida')
  }, 60_000)

  test('/sesiones --todas añade las conversaciones de Element suspendidas', async () => {
    const r = await runCli('/sesiones --todas')
    expect(r.out).toContain('Conversación dormida')
    expect(r.out).toContain('suspended')
  }, 60_000)

  test('un argumento desconocido enseña el uso', async () => {
    const r = await runCli('/sesiones --nada')
    expect(r.out).toContain('Uso: /sesiones')
  }, 60_000)
})
