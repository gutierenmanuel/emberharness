/**
 * Contract the Matrix bridge relies on: `--resume <uuid>` continues a
 * conversation from the transcript left by a previous run.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { CLI, fakeEnv, findTranscript, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'

const SESSION_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
let fake: ReturnType<typeof startFakeOpenAI>

beforeAll(() => {
  fake = startFakeOpenAI('respuesta para reanudar')
})
afterAll(() => fake.stop())

async function run(args: string[], configDir: string, cwd: string) {
  const proc = Bun.spawn([CLI, '-p', ...args, '--output-format', 'stream-json', '--verbose'], {
    cwd,
    env: fakeEnv(fake.baseUrl, configDir),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 90_000,
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
}

describe.skipIf(!hasCli)('resume e2e', () => {
  test('--resume <uuid> continues the conversation with the earlier history', async () => {
    const { configDir, cwd } = makeSandbox()

    const first = await run(['PRIMERA_PREGUNTA_ABC', '--session-id', SESSION_ID], configDir, cwd)
    expect(first.find(e => e.type === 'result')?.subtype).toBe('success')
    const transcript = findTranscript(configDir, SESSION_ID)
    expect(transcript).not.toBeNull()
    const sizeBefore = readFileSync(transcript!, 'utf8').length

    const before = fake.requests.length
    const second = await run(['SEGUNDA_PREGUNTA_XYZ', '--resume', SESSION_ID], configDir, cwd)
    const result = second.find(e => e.type === 'result')
    expect(result?.subtype).toBe('success')
    expect(result?.session_id).toBe(SESSION_ID)

    // The model saw both turns.
    const sent = JSON.stringify(fake.requests.slice(before))
    expect(sent).toContain('PRIMERA_PREGUNTA_ABC')
    expect(sent).toContain('SEGUNDA_PREGUNTA_XYZ')

    // The same transcript grew.
    const after = readFileSync(transcript!, 'utf8')
    expect(after.length).toBeGreaterThan(sizeBefore)
    expect(after).toContain('SEGUNDA_PREGUNTA_XYZ')
  }, 150_000)
})
