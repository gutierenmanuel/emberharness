/**
 * Contract the Matrix bridge relies on: bidirectional stream-json in headless
 * mode (`-p --input-format stream-json --output-format stream-json`).
 * No real provider is contacted; the model is a fake OpenAI-compatible server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CLI, fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'

const REPLY = 'respuesta del backend falso'
let fake: ReturnType<typeof startFakeOpenAI>

beforeAll(() => {
  fake = startFakeOpenAI(REPLY)
})
afterAll(() => fake.stop())

type Ev = { type: string; subtype?: string; session_id?: string; result?: string; message?: { content: unknown } }

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

describe.skipIf(!hasCli)('stream-json e2e', () => {
  test('two stdin turns yield one result event each and a stable session_id', async () => {
    const { configDir, cwd } = makeSandbox()
    const proc = Bun.spawn(
      [CLI, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages'],
      { cwd, env: fakeEnv(fake.baseUrl, configDir), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 },
    )

    const events: Ev[] = []
    let buf = ''
    const waiters: Array<() => void> = []
    const reader = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) {
            try {
              events.push(JSON.parse(line))
            } catch {
              /* ignore non-JSON noise */
            }
          }
        }
        waiters.splice(0).forEach(w => w())
      }
      waiters.splice(0).forEach(w => w())
    })()

    const waitForResults = async (n: number) => {
      const deadline = Date.now() + 60_000
      while (events.filter(e => e.type === 'result').length < n && Date.now() < deadline) {
        await new Promise<void>(r => {
          waiters.push(r)
          setTimeout(r, 500)
        })
      }
    }

    // Turn 2 is only sent once turn 1 has produced its result: that proves the
    // process stays alive and reads stdin incrementally, as the bridge needs.
    proc.stdin.write(userLine('primer turno'))
    await proc.stdin.flush()
    await waitForResults(1)
    proc.stdin.write(userLine('segundo turno'))
    await proc.stdin.flush()
    await waitForResults(2)
    proc.stdin.end()
    await proc.exited
    await reader

    const results = events.filter(e => e.type === 'result')
    expect(results.length).toBe(2)
    for (const r of results) {
      expect(r.subtype).toBe('success')
      expect(r.result).toContain(REPLY)
    }

    const init = events.find(e => e.type === 'system' && e.subtype === 'init')
    expect(init?.session_id).toBeTruthy()
    const ids = new Set(events.filter(e => e.session_id).map(e => e.session_id))
    expect(ids.size).toBe(1)

    // --replay-user-messages echoes each user message back.
    const replayed = events.filter(e => e.type === 'user')
    expect(replayed.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(replayed)).toContain('primer turno')
    expect(JSON.stringify(replayed)).toContain('segundo turno')
  }, 120_000)
})
