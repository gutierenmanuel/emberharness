/**
 * Watches the files that define MCP servers (`.mcp.json` of the cwd and its
 * ancestors, and the global `.claude.json` with user/project `mcpServers`) and
 * tells the caller when their MCP content really changed.
 *
 * Safety rules, all implemented as pure functions below so they are unit tested:
 *  - events are debounced (editors write by rename, `git checkout` touches
 *    several files) and reloads are coalesced: at most one running plus one queued;
 *  - a file whose JSON is invalid (half written) is ignored: nothing is
 *    reloaded and the caller is only told once so it can warn;
 *  - the global `.claude.json` is rewritten by the app all the time (cost,
 *    history...), so only a change of the `mcpServers` sections triggers a reload.
 *    That also makes our own writes invisible without extra bookkeeping.
 *
 * Set FNHARNESS_MCP_WATCH=0 to turn the watcher off.
 */
import { unwatchFile, watchFile } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join, normalize, parse } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { createSignal } from '../../utils/signal.js'

export const MCP_WATCH_DEBOUNCE_MS = 300
const WRITE_STABILITY_MS = 150
const MCP_WATCH_POLL_MS = 500

/** Emitted by `/cd`: the project `.mcp.json` set is different now. */
export const mcpCwdChanged = createSignal<[]>()

export function isMcpWatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FNHARNESS_MCP_WATCH
  return v !== '0' && v !== 'false' && v !== 'off'
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Directories to watch and the exact files inside them that matter. */
export function mcpWatchTargets(
  cwd: string,
  globalFile: string,
): { dirs: string[]; files: Set<string>; projectFiles: Set<string> } {
  const files = new Set<string>()
  const projectFiles = new Set<string>()
  const dirs = new Set<string>()
  let dir = cwd
  while (dir !== parse(dir).root) {
    const f = join(dir, '.mcp.json')
    files.add(f)
    projectFiles.add(f)
    dirs.add(dir)
    dir = dirname(dir)
  }
  files.add(globalFile)
  dirs.add(dirname(globalFile))
  return { dirs: [...dirs], files, projectFiles }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
      return sorted
    }
    return v
  })
}

export type Fingerprint = { ok: true; value: string } | { ok: false }

/**
 * Reduces a config file to the part that matters for MCP. `text === null`
 * means the file does not exist (a legit state: no servers).
 *  - project `.mcp.json`: its `mcpServers`;
 *  - global `.claude.json`: top-level `mcpServers` plus every project's.
 */
export function fingerprintMcpFile(kind: 'project' | 'global', text: string | null): Fingerprint {
  if (text === null) return { ok: true, value: 'missing' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
  const obj = parsed as Record<string, unknown>
  if (kind === 'project') return { ok: true, value: stableStringify(obj.mcpServers ?? null) }
  const projects: Record<string, unknown> = {}
  const rawProjects = obj.projects
  if (rawProjects && typeof rawProjects === 'object') {
    for (const [k, v] of Object.entries(rawProjects as Record<string, unknown>)) {
      const servers = (v as { mcpServers?: unknown } | null)?.mcpServers
      if (servers && typeof servers === 'object' && Object.keys(servers).length > 0) projects[k] = servers
    }
  }
  return { ok: true, value: stableStringify({ user: obj.mcpServers ?? null, projects }) }
}

/** Calls `fn` once, `ms` after the last `trigger()`. */
export function createDebouncer(ms: number, fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    trigger() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * Serialises an async job: calls while it runs collapse into a single rerun
 * afterwards. Resolves with the result of the last execution.
 */
export function createCoalescedRunner<T>(job: () => Promise<T>) {
  let running: Promise<T> | null = null
  let again = false
  async function loop(): Promise<T> {
    let result: T
    do {
      again = false
      result = await job()
    } while (again)
    return result
  }
  return {
    run(): Promise<T> {
      if (running) {
        again = true
        return running
      }
      running = loop().finally(() => {
        running = null
      })
      return running
    },
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export type McpConfigWatcher = { stop: () => Promise<void> }

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Starts watching. `onChange` receives the changed file; `onInvalid` is called
 * (once per broken content) when a file cannot be parsed, and nothing else
 * happens for it until it is valid again.
 */
export async function startMcpConfigWatcher(opts: {
  cwd: string
  globalFile: string
  debounceMs?: number
  pollMs?: number
  onChange: (path: string) => void
  onInvalid?: (path: string) => void
}): Promise<McpConfigWatcher> {
  const { files, projectFiles } = mcpWatchTargets(opts.cwd, opts.globalFile)
  const normalizedFiles = new Set([...files].map(f => normalize(f)))
  const last = new Map<string, string>()
  const warnedInvalid = new Set<string>()

  for (const f of files) {
    const fp = fingerprintMcpFile(projectFiles.has(f) ? 'project' : 'global', await readOrNull(f))
    if (fp.ok) last.set(normalize(f), fp.value)
  }

  let pendingPath = ''
  const debouncer = createDebouncer(opts.debounceMs ?? MCP_WATCH_DEBOUNCE_MS, () => opts.onChange(pendingPath))

  async function handle(rawPath: string): Promise<void> {
    const path = normalize(rawPath)
    if (!normalizedFiles.has(path)) return
    const kind = [...projectFiles].some(f => normalize(f) === path) ? 'project' : 'global'
    const fp = fingerprintMcpFile(kind, await readOrNull(path))
    if (!fp.ok) {
      if (!warnedInvalid.has(path)) {
        warnedInvalid.add(path)
        logForDebugging(`MCP config watcher: ${path} is not valid JSON yet, keeping the previous config`)
        opts.onInvalid?.(path)
      }
      return
    }
    warnedInvalid.delete(path)
    if (last.get(path) === fp.value) return
    last.set(path, fp.value)
    pendingPath = path
    debouncer.trigger()
  }

  // Stat polling per file (fs.watchFile): it also reports files that appear
  // later, survives editors that replace files by rename, and works for
  // dotfiles (Bun's fs.watch and chokidar never report `.mcp.json`). Each
  // path settles for a moment before it is read, so a truncate-then-write is
  // seen as one complete content instead of an "invalid" empty file.
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const polled: string[] = []
  for (const file of normalizedFiles) {
    watchFile(file, { interval: opts.pollMs ?? MCP_WATCH_POLL_MS, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return
      const old = settleTimers.get(file)
      if (old) clearTimeout(old)
      settleTimers.set(
        file,
        setTimeout(() => {
          settleTimers.delete(file)
          void handle(file)
        }, WRITE_STABILITY_MS),
      )
    })
    polled.push(file)
  }

  return {
    async stop() {
      debouncer.cancel()
      for (const t of settleTimers.values()) clearTimeout(t)
      settleTimers.clear()
      for (const f of polled) unwatchFile(f)
    },
  }
}
