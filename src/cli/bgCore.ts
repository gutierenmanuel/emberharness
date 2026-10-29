/**
 * Pure logic for background sessions (`fnharness --bg`, `ps`, `logs`, `stop`,
 * `attach`, `rm`). No I/O here: the effectful side lives in bg.ts so this file
 * can be unit tested without spawning anything.
 */

export type BgMeta = {
  /** Short id shown to the user (first 8 hex chars of the session UUID). */
  id: string
  /** Full session UUID; the transcript is `<project>/<sessionId>.jsonl`. */
  sessionId: string
  /** PID of the wrapper shell; it is also the process group leader. */
  pid: number
  cwd: string
  prompt: string
  /** Account (provider profile) the session was launched with. */
  account: string
  startedAt: number
  /** Set by `stop` so a killed session reads as `stopped`, not `lost`. */
  stoppedAt?: number
  /** CLI flags to reuse when the session is resumed (`--model`, permission mode...). */
  passthrough: string[]
}

export type BgStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'

export type ParsedBgArgs = {
  prompt: string | null
  /** Everything except the --bg flag and its prompt. */
  rest: string[]
}

/**
 * Splits `--bg "<prompt>"` / `--background=<prompt>` out of argv. The prompt is
 * the value right after the flag; with no value the last bare positional is used.
 */
export function parseBgArgs(args: readonly string[]): ParsedBgArgs {
  const rest: string[] = []
  let prompt: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--bg' || a === '--background') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        prompt = next
        i++
      }
      continue
    }
    const m = /^--(?:bg|background)=(.*)$/.exec(a)
    if (m) {
      prompt = m[1]!
      continue
    }
    rest.push(a)
  }
  if (prompt === null && rest.length > 0 && !rest[rest.length - 1]!.startsWith('-')) {
    prompt = rest.pop()!
  }
  return { prompt, rest }
}

export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8)
}

export type IdMatch =
  | { kind: 'found'; meta: BgMeta }
  | { kind: 'none' }
  | { kind: 'ambiguous'; ids: string[] }

/** Resolves an id or unambiguous prefix (of the short id or the UUID). */
export function resolveId(metas: readonly BgMeta[], query: string | undefined): IdMatch {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return { kind: 'none' }
  const exact = metas.find(m => m.id === q || m.sessionId === q)
  if (exact) return { kind: 'found', meta: exact }
  const hits = metas.filter(m => m.id.startsWith(q) || m.sessionId.startsWith(q))
  if (hits.length === 1) return { kind: 'found', meta: hits[0]! }
  if (hits.length > 1) return { kind: 'ambiguous', ids: hits.map(h => h.id) }
  return { kind: 'none' }
}

export function deriveStatus(
  meta: Pick<BgMeta, 'stoppedAt'>,
  alive: boolean,
  exitCode: number | null,
): BgStatus {
  if (alive) return 'running'
  if (meta.stoppedAt) return 'stopped'
  if (exitCode === null) return 'lost'
  return exitCode === 0 ? 'done' : 'failed'
}

export function shortPrompt(prompt: string, max = 40): string {
  const one = prompt.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

/** DD/MM HH:mm in local time, as the user prefers European dates. */
export function formatStart(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export type PsRow = { meta: BgMeta; status: BgStatus }

export function formatPsTable(rows: readonly PsRow[]): string {
  if (rows.length === 0) return 'No hay sesiones en segundo plano.'
  const header = ['ID', 'CUENTA', 'ESTADO', 'INICIO', 'PROMPT']
  const body = rows.map(r => [
    r.meta.id,
    r.meta.account,
    r.status,
    formatStart(r.meta.startedAt),
    shortPrompt(r.meta.prompt),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(b => b[i]!.length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')
  return [line(header), ...body.map(line)].join('\n')
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

function briefInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const first =
    o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.prompt ?? o.description
  return typeof first === 'string' ? clip(first, 100) : clip(JSON.stringify(o), 100)
}

/**
 * Renders one stream-json line as readable text, or null when the line is
 * noise (init, empty). Non-JSON lines are passed through untouched.
 */
export function formatEventLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let ev: any
  try {
    ev = JSON.parse(trimmed)
  } catch {
    return trimmed
  }
  const blocks: any[] = Array.isArray(ev?.message?.content) ? ev.message.content : []
  switch (ev?.type) {
    case 'system':
      return ev.subtype === 'init'
        ? `[inicio] modelo ${ev.model ?? '?'} · sesión ${ev.session_id ?? '?'}`
        : null
    case 'assistant': {
      const out: string[] = []
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) out.push(String(b.text).trimEnd())
        else if (b?.type === 'tool_use') out.push(`[tool] ${b.name} ${briefInput(b.input)}`.trimEnd())
      }
      return out.length ? out.join('\n') : null
    }
    case 'user': {
      const out: string[] = []
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue
        const c = Array.isArray(b.content)
          ? b.content.map((x: any) => x?.text ?? '').join(' ')
          : String(b.content ?? '')
        out.push(`[resultado${b.is_error ? ' ERROR' : ''}] ${clip(c, 160)}`)
      }
      return out.length ? out.join('\n') : null
    }
    case 'result': {
      const secs = typeof ev.duration_ms === 'number' ? ` en ${(ev.duration_ms / 1000).toFixed(1)}s` : ''
      return ev.is_error
        ? `[fin: error${secs}] ${clip(String(ev.result ?? (Array.isArray(ev.errors) ? ev.errors.join('; ') : ev.subtype) ?? ''), 300)}`
        : `[fin: ok${secs}]`
    }
    default:
      return null
  }
}

/**
 * Last `max` readable lines of a stream-json chunk. A tail read can start in
 * the middle of a line, so the first (possibly cut) line is dropped when
 * `partialStart` is true.
 */
export function tailFormatted(text: string, max: number, partialStart = false): string[] {
  const lines = text.split('\n')
  if (partialStart) lines.shift()
  const out: string[] = []
  for (const l of lines) {
    const f = formatEventLine(l)
    if (f !== null) out.push(...f.split('\n'))
  }
  return out.slice(-max)
}

/**
 * Incremental line splitter for `logs -f`: feed it chunks, get back complete
 * lines; the unterminated tail stays buffered.
 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const all = (buffer + chunk).split('\n')
  const rest = all.pop() ?? ''
  return { lines: all, rest }
}

/**
 * Flags for a session launched from the TUI. A headless run cannot ask for
 * permissions, so it inherits the current mode; anything not pre-approved is
 * denied rather than blocking forever.
 */
export function backgroundPassthrough(mode: string): string[] {
  if (mode === 'bypassPermissions') {
    return ['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
  }
  return mode && mode !== 'default' ? ['--permission-mode', mode] : []
}
