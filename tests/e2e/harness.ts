/**
 * Helpers for end-to-end tests that drive the real ./cli binary:
 * a fake OpenAI-compatible backend, a throwaway config dir and a pseudo-terminal
 * capture of the TUI with ANSI codes stripped.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

export const APP_DIR = resolve(import.meta.dir, '..', '..')
export const CLI = join(APP_DIR, 'cli')
export const hasCli = existsSync(CLI)

export const FAKE_MODEL = 'fake-model'

/** One OpenAI chat.completions stream that says `reply` and stops. */
export function sseReply(reply: string): string {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 0,
      model: FAKE_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: reply }) +
    chunk({}, 'stop') +
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 0,
      model: FAKE_MODEL,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    })}\n\n` +
    'data: [DONE]\n\n'
  )
}

/** Starts a fake backend; every chat request gets the same reply. */
export function startFakeOpenAI(reply: string) {
  const requests: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      }
      if (url.pathname.endsWith('/chat/completions')) {
        const body = (await req.json()) as { stream?: boolean }
        requests.push(body)
        if (body.stream === false) {
          return Response.json({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            model: FAKE_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          })
        }
        return new Response(sseReply(reply), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

/**
 * Fresh config dir (onboarding done, `cwd` trusted) and an empty working dir,
 * both outside any repo so no CLAUDE.md or .mcp.json leaks in.
 */
export function makeSandbox(): { configDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'fnh-e2e-'))
  const configDir = join(root, 'config')
  const cwd = join(root, 'work')
  mkdirSync(configDir)
  mkdirSync(cwd)
  writeFileSync(
    join(configDir, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
  )
  return { configDir, cwd }
}

export function fakeEnv(baseUrl: string, configDir: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_MULTIMODEL_PROVIDER: 'custom',
    CLAUDE_MULTIMODEL_BASE_URL: baseUrl,
    CLAUDE_MULTIMODEL_MODEL: FAKE_MODEL,
    FNHARNESS_DISABLE_MODELS_FETCH: '1',
    ...extra,
  }
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n || 1)))
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\r/g, '\n')
}

/**
 * Runs the TUI in a pseudo-terminal (`script`) for `seconds` and returns the
 * de-duplicated non-empty lines it printed.
 */
export async function captureTui(
  env: Record<string, string | undefined>,
  cwd: string,
  seconds = 8,
  columns = 120,
): Promise<string[]> {
  const proc = Bun.spawn(
    ['script', '-qc', `timeout ${seconds} ${CLI}`, '/dev/null'],
    {
      cwd,
      env: { ...env, COLUMNS: String(columns), LINES: '30', TERM: 'xterm-256color' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const seen = new Set<string>()
  return stripAnsi(out)
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '' && !seen.has(l) && seen.add(l))
}

/** Finds `<configDir>/projects/*\/<id>.jsonl`. */
export function findTranscript(configDir: string, id: string): string | null {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return null
  for (const d of readdirSync(projects)) {
    const p = join(projects, d, `${id}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}
