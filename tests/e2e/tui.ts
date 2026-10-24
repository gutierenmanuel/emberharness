/**
 * Drives the real TUI in a pseudo-terminal (`script`): type text, wait for
 * output. Output is kept with ANSI stripped. TMUX is removed from the env so
 * the TUI does not try to talk to a multiplexer.
 */
import { CLI, stripAnsi } from './harness.js'

export type Tui = {
  /** Everything printed so far (ANSI stripped). */
  text: () => string
  /** Types `s` followed by Enter. */
  line: (s: string) => void
  /** Types raw text. */
  type: (s: string) => void
  waitFor: (re: RegExp | string, timeoutMs?: number) => Promise<void>
  stop: () => Promise<void>
}

export function startTui(env: Record<string, string | undefined>, cwd: string, columns = 140): Tui {
  const clean: Record<string, string | undefined> = { ...env, COLUMNS: String(columns), LINES: '40', TERM: 'xterm-256color' }
  delete clean.TMUX
  delete clean.TMUX_PANE
  const proc = Bun.spawn(['script', '-qc', CLI, '/dev/null'], {
    cwd,
    env: clean,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let buf = ''
  const decoder = new TextDecoder()
  void (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk)
    }
  })()
  const text = () => stripAnsi(buf)
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  return {
    text,
    type: s => {
      proc.stdin.write(s)
      proc.stdin.flush()
    },
    line(s) {
      this.type(s)
      setTimeout(() => this.type('\r'), 150)
    },
    async waitFor(re, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        // The TUI repaints with cursor moves, so spaces are not reliable:
        // string needles are compared with all whitespace removed.
        const t = text()
        if (typeof re === 'string' ? t.replace(/\s+/g, '').includes(re.replace(/\s+/g, '')) : re.test(t)) return
        await sleep(100)
      }
      throw new Error(`timeout waiting for ${re}; tail:\n${text().slice(-1500)}`)
    },
    async stop() {
      try {
        proc.stdin.write('\x03\x03')
        proc.stdin.flush()
      } catch {}
      await sleep(300)
      proc.kill('SIGKILL')
      await proc.exited
    },
  }
}
