import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'
import type { SessionKind } from './concurrentSessions.js'

export type LiveSession = {
  pid: number
  sessionId?: string
  cwd?: string
  kind?: SessionKind
}

/**
 * Live sessions from the `<config dir>/sessions/<pid>.json` registry written by
 * registerSession(). Stale files (dead pid) are skipped. Used by `--continue`
 * to avoid picking a transcript that a running bg session is still writing.
 */
export async function listAllLiveSessions(): Promise<LiveSession[]> {
  const dir = join(getClaudeConfigHomeDir(), 'sessions')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue
    try {
      const s = JSON.parse(await readFile(join(dir, f), 'utf8')) as LiveSession
      if (isProcessRunning(s.pid)) out.push(s)
    } catch {
      // unreadable or half-written: skip
    }
  }
  return out
}
