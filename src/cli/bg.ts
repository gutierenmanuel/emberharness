/**
 * Background sessions: `fnharness --bg "<prompt>"`, `ps`, `logs <id> [-f]`,
 * `stop <id>`, `attach <id>`, `rm <id>`.
 *
 * A bg session is a detached headless run (`-p --output-format stream-json`)
 * of this same binary. State lives under `<CLAUDE_CONFIG_DIR>/bg/<id>/`:
 *   meta.json     launch data (see BgMeta)
 *   events.jsonl  stream-json stdout, the source for `logs`
 *   stderr.log    stderr of the child
 *   exit          exit code, written by the wrapper shell when the child ends
 * The pure parts (arg parsing, status, formatting) are in bgCore.ts.
 */
import { spawn, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readSync,
} from 'fs'
import { basename, join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import {
  type BgMeta,
  type BgStatus,
  deriveStatus,
  formatEventLine,
  formatPsTable,
  parseBgArgs,
  resolveId,
  shortId,
  splitLines,
} from './bgCore.js'

export function getBgDir(): string {
  return join(getClaudeConfigHomeDir(), 'bg')
}

const sessionDir = (id: string) => join(getBgDir(), id)

/** Command that re-runs this same program (compiled binary, or `bun script`). */
function selfCommand(): string[] {
  const exe = process.execPath
  return /^bun(-|$)/.test(basename(exe)) ? [exe, process.argv[1]!] : [exe]
}

function readExit(id: string): number | null {
  try {
    const n = parseInt(readFileSync(join(sessionDir(id), 'exit'), 'utf8').trim(), 10)
    return Number.isNaN(n) ? null : n
  } catch {
    return null
  }
}

export function statusOf(meta: BgMeta): BgStatus {
  return deriveStatus(meta, isProcessRunning(meta.pid), readExit(meta.id))
}

export function listBgSessions(): BgMeta[] {
  let names: string[]
  try {
    names = readdirSync(getBgDir())
  } catch {
    return []
  }
  const out: BgMeta[] = []
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(getBgDir(), n, 'meta.json'), 'utf8')) as BgMeta)
    } catch {
      // half-written or foreign dir: ignore
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

function fail(msg: string): never {
  process.stderr.write(`fnharness: ${msg}\n`)
  process.exit(1)
}

function pick(idArg: string | undefined): BgMeta {
  if (!idArg) fail('falta el id de la sesión (mira `fnharness ps`)')
  const m = resolveId(listBgSessions(), idArg)
  if (m.kind === 'found') return m.meta
  if (m.kind === 'ambiguous') fail(`id ambiguo "${idArg}": ${m.ids.join(', ')}`)
  return fail(`no existe la sesión "${idArg}"`)
}

export type LaunchOptions = {
  prompt: string
  /** CLI flags forwarded to the child and reused on `attach` (model, permission mode...). */
  passthrough: string[]
  cwd: string
  /** Fork the conversation of this session instead of starting from scratch. */
  forkFrom?: string
}

/** Launches a detached headless session and registers it. Throws on spawn failure. */
export function launchBg(opts: LaunchOptions): BgMeta {
  const sessionId = randomUUID()
  const id = shortId(sessionId)
  const dir = sessionDir(id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const eventsPath = join(dir, 'events.jsonl')
  const out = openSync(eventsPath, 'a')
  const err = openSync(join(dir, 'stderr.log'), 'a')

  const account = process.env.CLAUDE_MULTIMODEL_ACCOUNT || 'default'
  const [exe, ...exeArgs] = selfCommand()
  const childArgs = [
    ...exeArgs,
    ...opts.passthrough,
    ...(opts.forkFrom ? ['--resume', opts.forkFrom, '--fork-session'] : []),
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    sessionId,
  ]
  // The wrapper shell records the exit code so `ps` can tell done from failed.
  // detached:true makes the child its own session/group leader (setsid), so
  // `stop` can signal the whole group and the parent terminal can close.
  const child = spawn(
    'sh',
    ['-c', '"$@"; echo $? > "$0"', join(dir, 'exit'), exe!, ...childArgs],
    {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', out, err],
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_KIND: 'bg',
        CLAUDE_CODE_SESSION_NAME: id,
        CLAUDE_CODE_SESSION_LOG: eventsPath,
      },
    },
  )
  child.unref()
  closeSync(out)
  closeSync(err)

  const meta: BgMeta = {
    id,
    sessionId,
    pid: child.pid!,
    cwd: opts.cwd,
    prompt: opts.prompt,
    account,
    startedAt: Date.now(),
    passthrough: opts.passthrough,
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  return meta
}

export function launchSummary(meta: BgMeta): string {
  return (
    `Sesión en segundo plano ${meta.id} (cuenta ${meta.account}, pid ${meta.pid})\n` +
    `  fnharness logs ${meta.id} -f   seguir la salida\n` +
    `  fnharness ps               listar\n` +
    `  fnharness stop ${meta.id}      parar\n` +
    `  fnharness attach ${meta.id}    reanudar en la TUI\n`
  )
}

/** `fnharness --bg "<prompt>" [flags]`: launches a detached session and prints its id. */
export async function handleBgFlag(args: string[]): Promise<void> {
  const { prompt, rest } = parseBgArgs(args)
  if (!prompt) fail('--bg necesita un prompt: fnharness --bg "tarea"')
  const meta = launchBg({ prompt, passthrough: rest, cwd: process.cwd() })
  process.stdout.write(launchSummary(meta))
}

export async function psHandler(_args: string[]): Promise<void> {
  const rows = listBgSessions().map(meta => ({ meta, status: statusOf(meta) }))
  process.stdout.write(formatPsTable(rows) + '\n')
}

function readFrom(path: string, offset: number): { text: string; next: number } {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return { text: '', next: offset }
  }
  if (size <= offset) return { text: '', next: offset }
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    return { text: buf.toString('utf8'), next: size }
  } finally {
    closeSync(fd)
  }
}

async function followLogs(meta: BgMeta, follow: boolean): Promise<void> {
  const path = join(sessionDir(meta.id), 'events.jsonl')
  let offset = 0
  let pending = ''
  const emit = (lines: string[]) => {
    for (const l of lines) {
      const f = formatEventLine(l)
      if (f !== null) process.stdout.write(f + '\n')
    }
  }
  for (;;) {
    const chunk = readFrom(path, offset)
    offset = chunk.next
    const { lines, rest } = splitLines(pending, chunk.text)
    pending = rest
    emit(lines)
    if (!follow) break
    if (statusOf(meta) !== 'running' && !chunk.text) {
      // Drain one last time, then flush an unterminated tail and stop.
      const last = readFrom(path, offset)
      if (!last.text) break
    }
    await new Promise(r => setTimeout(r, 300))
  }
  if (pending) emit([pending])
  const errPath = join(sessionDir(meta.id), 'stderr.log')
  const stderrText = existsSync(errPath) ? readFileSync(errPath, 'utf8').trim() : ''
  if (stderrText && statusOf(meta) === 'failed') {
    process.stdout.write(`[stderr]\n${stderrText.slice(-800)}\n`)
  }
}

export async function logsHandler(args: string[]): Promise<void> {
  const follow = args.includes('-f') || args.includes('--follow')
  const meta = pick(args.find(a => !a.startsWith('-')))
  await followLogs(meta, follow)
}

export async function killHandler(idArg: string | undefined): Promise<void> {
  const meta = pick(idArg)
  if (statusOf(meta) !== 'running') {
    process.stdout.write(`La sesión ${meta.id} ya no está en marcha (${statusOf(meta)}).\n`)
    return
  }
  const dir = sessionDir(meta.id)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, stoppedAt: Date.now() }, null, 2))
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-meta.pid, sig)
    } catch {
      try {
        process.kill(meta.pid, sig)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 20 && isProcessRunning(meta.pid); i++) {
    await new Promise(r => setTimeout(r, 150))
  }
  if (isProcessRunning(meta.pid)) signal('SIGKILL')
  process.stdout.write(`Sesión ${meta.id} detenida.\n`)
}

export async function rmHandler(idArg: string | undefined): Promise<void> {
  const meta = pick(idArg)
  if (statusOf(meta) === 'running') fail(`la sesión ${meta.id} sigue en marcha: páramela antes con \`fnharness stop ${meta.id}\``)
  rmSync(sessionDir(meta.id), { recursive: true, force: true })
  process.stdout.write(`Sesión ${meta.id} borrada del registro (el transcript se conserva).\n`)
}

/**
 * Finished session: resume it in the TUI (`--resume`, same cwd and account).
 * Still running: v1 limit, a session can't be taken over live, so show its
 * log with -f instead.
 */
export async function attachHandler(idArg: string | undefined): Promise<void> {
  const meta = pick(idArg)
  if (statusOf(meta) === 'running') {
    process.stderr.write(
      `La sesión ${meta.id} sigue en marcha: no se puede tomar en vivo, sigo sus logs ` +
        `(Ctrl+C para salir; al terminar, \`fnharness attach ${meta.id}\` la reanuda en la TUI).\n`,
    )
    await followLogs(meta, true)
    return
  }
  const env = { ...process.env }
  if (meta.account !== 'default') env.CLAUDE_MULTIMODEL_ACCOUNT = meta.account
  const [exe, ...exeArgs] = selfCommand()
  const r = spawnSync(exe!, [...exeArgs, ...meta.passthrough, '--resume', meta.sessionId], {
    cwd: existsSync(meta.cwd) ? meta.cwd : process.cwd(),
    env,
    stdio: 'inherit',
  })
  process.exit(r.status ?? 0)
}
