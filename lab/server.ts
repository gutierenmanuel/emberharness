// Laboratorio de mocks de fnharness (bloque G del ROADMAP).
//
//   bun run lab            => http://127.0.0.1:7700
//
// - crea el JSON de mocks en un directorio temporal,
// - lanza ttyd en 127.0.0.1:7690 ejecutando bin/fnharness con FNHARNESS_MOCKS,
// - sirve lab/index.html y acepta POST /mocks y POST /restart.
// Solo escucha en 127.0.0.1.

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { EMPTY_MOCKS, parseMocks, type MocksState } from '../src/dev/mocksCore.js'

const HOST = '127.0.0.1'
const ROOT = resolve(import.meta.dir, '..')
const PORT = Number(process.env.LAB_PORT ?? 7700)
const TTYD_PORT = Number(process.env.LAB_TTYD_PORT ?? 7690)
let account = process.env.LAB_ACCOUNT ?? 'qwen36'

const dir = mkdtempSync(join(tmpdir(), 'fnharness-lab-'))
const mocksFile = join(dir, 'mocks.json')
let state: MocksState = { ...EMPTY_MOCKS }

// Escritura atómica (tmp + rename) para que el watcher nunca lea un JSON a medias.
function writeMocks(next: MocksState): void {
  state = next
  const tmp = `${mocksFile}.tmp`
  writeFileSync(tmp, JSON.stringify(next))
  renameSync(tmp, mocksFile)
}
writeMocks(state)

let ttyd: ReturnType<typeof Bun.spawn> | null = null

async function stopTtyd(): Promise<void> {
  const p = ttyd
  ttyd = null
  if (!p) return
  p.kill('SIGTERM')
  await p.exited
}

function startTtyd(): void {
  ttyd = Bun.spawn(
    [
      'ttyd', '-i', HOST, '-p', String(TTYD_PORT), '-W',
      '-t', 'fontSize=15',
      '-t', 'theme={"background":"#0d1117","foreground":"#e6edf3"}',
      join(ROOT, 'bin/fnharness'), '--account', account,
    ],
    {
      cwd: process.env.LAB_CWD ?? ROOT, // un directorio ya confiado evita el aviso de confianza
      env: { ...process.env, FNHARNESS_MOCKS: mocksFile },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
}

async function restartTtyd(): Promise<void> {
  await stopTtyd()
  startTtyd()
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return new Response(Bun.file(join(ROOT, 'lab/index.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (req.method === 'GET' && pathname === '/state') {
      return json({ mocks: state, account, ttydPort: TTYD_PORT })
    }
    if (req.method === 'POST' && pathname === '/mocks') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json({ error: 'JSON inválido' }, 400)
      }
      writeMocks(parseMocks(body))
      return json({ ok: true, mocks: state })
    }
    if (req.method === 'POST' && pathname === '/restart') {
      let body: { account?: unknown } = {}
      try {
        body = (await req.json()) as typeof body
      } catch {
        // cuerpo vacío: reinicia con la misma cuenta
      }
      if (typeof body.account === 'string' && /^[\w.-]{1,40}$/.test(body.account)) {
        account = body.account
      }
      await restartTtyd()
      return json({ ok: true, account })
    }
    return new Response('not found', { status: 404 })
  },
})

startTtyd()
console.log(`fnharness lab: http://${HOST}:${server.port}  (ttyd :${TTYD_PORT}, cuenta ${account})`)
console.log(`mocks: ${mocksFile}`)

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  await stopTtyd()
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
