/**
 * /perfil en la TUI real (pseudo-terminal) contra un backend OpenAI falso: aplicar un perfil en
 * caliente cambia las herramientas del siguiente turno, uno que exige reinicio avisa del
 * comando cuando no hay lanzador, y `/perfil nuevo` escribe el JSON con la sesión actual.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fakeEnv, hasCli, makeSandbox, startFakeOpenAI } from './harness.js'
import { startTui } from './tui.js'

type ChatBody = { stream?: boolean; tools?: Array<{ function: { name: string } }> }

let fake: ReturnType<typeof startFakeOpenAI>
beforeAll(() => {
  fake = startFakeOpenAI('respuesta del turno')
})
afterAll(() => fake.stop())

/** La TUI está lista para teclear (mismo criterio que los otros e2e de TUI). */
async function ready(tui: ReturnType<typeof startTui>) {
  await tui.waitFor(/for shortcuts|bypass|simple mode|❯|>/i, 30_000)
  await new Promise(r => setTimeout(r, 2000))
}

const mainRequests = () => (fake.requests as ChatBody[]).filter(b => b.stream !== false && (b.tools?.length ?? 0) > 0)

describe.skipIf(!hasCli)('/perfil en la TUI', () => {
  test('/perfil simple se aplica en caliente: el turno siguiente envía solo seis herramientas', async () => {
    const { configDir, cwd } = makeSandbox()
    const tui = startTui(fakeEnv(fake.baseUrl, configDir), cwd)
    try {
      await ready(tui)
      tui.line('/perfil simple')
      await tui.waitFor('Perfil simple', 30_000)
      fake.requests.length = 0
      tui.line('di hola')
      await tui.waitFor('respuesta del turno', 30_000)
      const last = mainRequests().at(-1)!
      expect(last.tools!.map(t => t.function.name).sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
      expect(JSON.parse(readFileSync(join(configDir, 'profiles.json'), 'utf8')).active).toBe('simple')
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('/perfil minimo exige reiniciar (bare): sin lanzador avisa del comando y no toca la sesión', async () => {
    const { configDir, cwd } = makeSandbox()
    const tui = startTui(fakeEnv(fake.baseUrl, configDir), cwd)
    try {
      await ready(tui)
      tui.line('/perfil minimo')
      await tui.waitFor('No hay lanzador que relance', 30_000)
      expect(tui.text().replace(/\s+/g, '')).toContain('--perfilminimo')
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('/perfil nuevo escribe el JSON de la sesión actual y muestra la ruta', async () => {
    const { configDir, cwd } = makeSandbox()
    const tui = startTui(fakeEnv(fake.baseUrl, configDir), cwd)
    try {
      await ready(tui)
      tui.line('/perfil nuevo mio')
      await tui.waitFor('creado en', 30_000)
      const path = join(configDir, 'profiles', 'mio.json')
      expect(existsSync(path)).toBe(true)
      // La cuenta falsa es local: arranca en Simple y el perfil nuevo recoge sus siete herramientas.
      expect(JSON.parse(readFileSync(path, 'utf8')).tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'])
    } finally {
      await tui.stop()
    }
  }, 90_000)
})
