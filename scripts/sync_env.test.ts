import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

// Envoltorio para que `bun run test:unit` ejecute también las pruebas bash de sync_env.sh.
test('sync_env.sh: pruebas sobre HOME temporal', () => {
  const r = Bun.spawnSync(['bash', resolve(import.meta.dir, 'sync_env.test.sh')])
  expect(r.stdout.toString() + r.stderr.toString()).toContain('0 fallos')
  expect(r.exitCode).toBe(0)
})
