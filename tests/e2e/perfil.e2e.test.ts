/**
 * Perfiles de contexto (--perfil) con el ./cli real contra un backend OpenAI falso:
 * el perfil `minimo` envía el system prompt propio y solo cuatro herramientas; un perfil
 * desconocido falla antes de llamar a nadie; un perfil de usuario sustituye al de fábrica.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'

const MINIMO_PROMPT =
  'Eres un agente que trabaja en el directorio actual. Para crear o cambiar ficheros llama SIEMPRE a la herramienta Write o Edit con ruta absoluta; nunca pegues el código en el chat. Responde en español, breve. Directorio actual: '

type ChatBody = {
  stream?: boolean
  messages: Array<{ role: string; content: unknown }>
  tools?: Array<{ function: { name: string } }>
}

let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI('hecho')
})
afterAll(() => fake.stop())

async function run(args: string[], extraEnv: Record<string, string> = {}, setup?: (configDir: string) => void) {
  const { configDir, cwd } = makeSandbox()
  setup?.(configDir)
  fake.requests.length = 0
  const proc = Bun.spawn([CLI, ...args], {
    cwd,
    env: fakeEnv(fake.baseUrl, configDir, extraEnv) as Record<string, string>,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  // La petición del bucle principal es la que lleva herramientas (hay otras auxiliares sin ellas).
  const main = (fake.requests as ChatBody[]).filter(b => (b.tools?.length ?? 0) > 0).pop()
  return { out, err, code, main, cwd }
}

const systemText = (b: ChatBody) =>
  b.messages
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')

describe.skipIf(!hasCli)('--perfil', () => {
  test('minimo: system prompt propio y solo Read, Write, Edit y Glob', async () => {
    const r = await run(['--perfil', 'minimo', '-p', 'di hola'])
    expect(r.out).toContain('hecho')
    expect(r.main).toBeDefined()
    expect(r.main!.tools!.map(t => t.function.name).sort()).toEqual(['Edit', 'Glob', 'Read', 'Write'])
    // El cliente antepone su cabecera de atribución y la línea de identidad a cualquier prompt propio.
    const sys = systemText(r.main!)
    expect(sys.startsWith('x-anthropic-billing-header')).toBe(true)
    expect(sys.endsWith(`${MINIMO_PROMPT}${r.cwd}`)).toBe(true)
    expect(sys).not.toContain('# Environment')
  }, 70_000)

  test('simple: seis herramientas y el system prompt por defecto', async () => {
    const r = await run(['--perfil', 'simple', '-p', 'di hola'])
    expect(r.out).toContain('hecho')
    expect(r.main!.tools!.map(t => t.function.name).sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
    expect(systemText(r.main!)).not.toBe(MINIMO_PROMPT)
  }, 70_000)

  test('un --system-prompt explícito gana al del perfil', async () => {
    const r = await run(['--perfil', 'minimo', '--system-prompt', 'Prompt de la CLI', '-p', 'di hola'])
    expect(systemText(r.main!).endsWith('Prompt de la CLI')).toBe(true)
    expect(systemText(r.main!)).not.toContain('Eres un agente que trabaja')
  }, 70_000)

  test('FNHARNESS_PROFILE y el perfil de usuario sustituyendo al de fábrica', async () => {
    const r = await run(['-p', 'di hola'], { FNHARNESS_PROFILE: 'simple' }, configDir => {
      const dir = join(configDir, 'profiles')
      mkdirSync(dir)
      writeFileSync(join(dir, 'simple.json'), JSON.stringify({ tools: ['Read'], systemPrompt: { mode: 'append', text: 'EXTRA-DEL-USUARIO' } }))
    })
    expect(r.main!.tools!.map(t => t.function.name)).toEqual(['Read'])
    expect(systemText(r.main!)).toContain('EXTRA-DEL-USUARIO')
  }, 70_000)

  test('un perfil desconocido falla con la lista de los disponibles, sin llamar al backend', async () => {
    const r = await run(['--perfil', 'nada', '-p', 'di hola'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('Perfil desconocido "nada". Disponibles: full, simple, minimo')
    expect(fake.requests).toHaveLength(0)
  }, 70_000)
})
