/**
 * Reproducible memory benchmark for long sessions.
 *
 * Drives a real binary (default ./cli of this checkout) inside a pseudo-terminal
 * against a scripted fake OpenAI-compatible backend: every prompt triggers
 * `--calls` rounds of a Bash tool call that prints `--size` bytes, then a short
 * text reply. After each prompt it records the RSS of the CLI process, so the
 * growth per prompt and per tool call can be compared before and after a fix.
 *
 *   bun run scripts/mem_bench.ts [--cli ./cli] [--prompts 30] [--calls 10]
 *                                [--size 20000] [--snapshot] [--out file.json]
 *
 * With --snapshot it sends SIGUSR2 at the end with FNHARNESS_MEMDUMP_SNAPSHOT=1
 * and prints where the heap stats / snapshot were written.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fakeEnv, FAKE_MODEL, makeSandbox } from '../tests/e2e/harness.js'

const argv = process.argv.slice(2)
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def
}
const CLI_PATH = resolve(arg('cli', join(import.meta.dir, '..', 'cli')))
const PROMPTS = Number(arg('prompts', '30'))
const CALLS = Number(arg('calls', '10'))
const SIZE = Number(arg('size', '20000'))
const SNAPSHOT = argv.includes('--snapshot')
const OUT = arg('out', '')

type Msg = { role: string; content?: unknown }
const sse = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const usage = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } })}\n\n`

const { configDir, cwd } = makeSandbox()
writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
const bigFile = join(cwd, 'big.txt')
{
  const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit 0123456789\n'
  writeFileSync(bigFile, line.repeat(Math.ceil(SIZE / line.length) + 1).slice(0, SIZE))
}

let finished = 0
let callSeq = 0
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
    if (!url.pathname.endsWith('/chat/completions')) return new Response('nf', { status: 404 })
    const body = (await req.json()) as { stream?: boolean; messages: Msg[] }
    if (body.stream === false) {
      return Response.json({ id: 'c', object: 'chat.completion', model: FAKE_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    // Tool rounds since the last real user message.
    let rounds = 0
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i]!
      if (m.role === 'user') break
      if (m.role === 'tool') rounds++
    }
    const isMain = JSON.stringify(body.messages).includes('MEMBENCH')
    let out: string
    if (isMain && rounds < CALLS) {
      const id = `call_${++callSeq}`
      const args = { command: `cat ${bigFile}; echo round-${callSeq}`, description: 'print file' }
      out = sse({ role: 'assistant', content: `paso ${callSeq}` }) +
        sse({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'Bash', arguments: JSON.stringify(args) } }] }) +
        sse({}, 'tool_calls')
    } else {
      if (isMain) finished++
      out = sse({ role: 'assistant', content: `listo ${finished}` }) + sse({}, 'stop')
    }
    return new Response(out + usage + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  },
})

const dumpDir = join(configDir, 'memdumps')
mkdirSync(dumpDir, { recursive: true })
const env: Record<string, string | undefined> = {
  ...fakeEnv(`http://127.0.0.1:${server.port}/v1`, configDir),
  FNHARNESS_MEMDUMP_DIR: dumpDir,
  FNHARNESS_MEMDUMP_SNAPSHOT: SNAPSHOT ? '1' : '0',
  COLUMNS: '140',
  LINES: '40',
  TERM: 'xterm-256color',
}
delete env.TMUX
delete env.TMUX_PANE

const proc = Bun.spawn(
  ['script', '-qc', `stty cols 140 rows 40 2>/dev/null; exec ${CLI_PATH} --dangerously-skip-permissions`, '/dev/null'],
  { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
)
// Drain output so the pty never blocks; keep only a small tail.
let tail = ''
void (async () => {
  const dec = new TextDecoder()
  for await (const c of proc.stdout as unknown as AsyncIterable<Uint8Array>) tail = (tail + dec.decode(c)).slice(-4000)
})()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const type = (s: string) => {
  proc.stdin.write(s)
  proc.stdin.flush()
}

function cliPid(): number | null {
  // script -> sh? -> cli ; find the descendant whose exe is the CLI.
  const kids = (pid: number): number[] => {
    try {
      return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
    } catch {
      return []
    }
  }
  const stack = [proc.pid]
  while (stack.length) {
    const p = stack.pop()!
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0')[0]
      if (cmd === CLI_PATH) return p
    } catch {}
    stack.push(...kids(p))
  }
  return null
}
const rssMB = (pid: number) => {
  const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)
  return m ? Math.round(Number(m[1]) / 1024) : -1
}

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await sleep(100)
  }
  throw new Error(`timeout: ${what}\n${tail.slice(-1500)}`)
}

const samples: Array<{ prompt: number; toolCalls: number; rssMB: number }> = []
try {
  await waitFor(() => cliPid() !== null, 15_000, 'cli start')
  const pid = cliPid()!
  await sleep(4000)
  samples.push({ prompt: 0, toolCalls: 0, rssMB: rssMB(pid) })
  console.log(`cli pid ${pid} start rss ${samples[0]!.rssMB} MB`)
  for (let i = 1; i <= PROMPTS; i++) {
    type(`MEMBENCH prompt ${i}`)
    await sleep(150)
    type('\r')
    await waitFor(() => finished >= i, 120_000, `prompt ${i}`)
    await sleep(400)
    const r = rssMB(pid)
    samples.push({ prompt: i, toolCalls: callSeq, rssMB: r })
    console.log(`prompt ${i} calls ${callSeq} rss ${r} MB`)
  }
  if (SNAPSHOT || true) {
    process.kill(pid, 'SIGUSR2')
    await sleep(SNAPSHOT ? 20_000 : 1500)
    console.log('memdumps:', readdirSync(dumpDir).map(f => join(dumpDir, f)).join(' '))
  }
} finally {
  try {
    type('\x03\x03')
  } catch {}
  await sleep(300)
  proc.kill('SIGKILL')
  const p = cliPid()
  if (p) process.kill(p, 'SIGKILL')
  server.stop(true)
}
const first = samples[0]!.rssMB
const last = samples[samples.length - 1]!.rssMB
const summary = {
  cli: CLI_PATH,
  prompts: PROMPTS,
  callsPerPrompt: CALLS,
  outputBytes: SIZE,
  startMB: first,
  endMB: last,
  growthPerToolCallKB: callSeq ? Math.round(((last - first) * 1024) / callSeq) : 0,
  samples,
}
console.log(JSON.stringify({ ...summary, samples: undefined }))
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2))
