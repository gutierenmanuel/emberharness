/**
 * Contract the Matrix bridge relies on: the launch flags it passes to the
 * binary. Fake OpenAI backend and a throwaway CLAUDE_CONFIG_DIR only.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { CLI, fakeEnv, findTranscript, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'

const REPLY = 'respuesta con flags'
const SESSION_ID = '11111111-2222-4333-8444-555555555555'
const EXTRA_PROMPT = 'MARCADOR_PROMPT_ADICIONAL_7731'
let fake: ReturnType<typeof startFakeOpenAI>

beforeAll(() => {
  fake = startFakeOpenAI(REPLY)
})
afterAll(() => fake.stop())

describe.skipIf(!hasCli)('launch flags e2e', () => {
  test('--session-id, system prompt file, mcp, plugin and SessionStart hook', async () => {
    const { configDir, cwd } = makeSandbox()
    const aux = join(dirname(configDir), 'aux')
    mkdirSync(aux)

    const promptFile = join(aux, 'extra.txt')
    writeFileSync(promptFile, EXTRA_PROMPT)

    const mcpConfig = join(aux, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }))

    const pluginDir = join(aux, 'plugin')
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'contract-plugin', version: '0.0.1', description: 'e2e contract plugin' }),
    )

    const hookOut = join(aux, 'hook-ran.txt')
    const settings = join(aux, 'settings.json')
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo hook-ok > ${hookOut}` }] }] },
      }),
    )

    const before = fake.requests.length
    const proc = Bun.spawn(
      [
        CLI, '-p', 'di hola',
        '--output-format', 'stream-json', '--verbose',
        '--session-id', SESSION_ID,
        '--append-system-prompt-file', promptFile,
        '--mcp-config', mcpConfig,
        '--plugin-dir', pluginDir,
        '--settings', settings,
      ],
      { cwd, env: fakeEnv(fake.baseUrl, configDir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited

    const events = out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    const result = events.find(e => e.type === 'result')
    expect(result?.subtype).toBe('success')
    expect(result?.result).toContain(REPLY)
    expect(result?.session_id).toBe(SESSION_ID)

    // SessionStart hook ran.
    expect(existsSync(hookOut)).toBe(true)
    expect(readFileSync(hookOut, 'utf8').trim()).toBe('hook-ok')

    // Additional system prompt reached the model.
    const sent = JSON.stringify(fake.requests.slice(before))
    expect(sent).toContain(EXTRA_PROMPT)

    // Plugin loaded, as reported by the init event.
    const init = events.find(e => e.type === 'system' && e.subtype === 'init')
    expect(JSON.stringify(init?.plugins ?? [])).toContain('contract-plugin')

    // Transcript under the temporary config dir, named after the session id.
    const transcript = findTranscript(configDir, SESSION_ID)
    expect(transcript).not.toBeNull()
    expect(readFileSync(transcript!, 'utf8')).toContain('di hola')
  }, 120_000)
})
