/**
 * `/otel` and `/telemetry` against the real ./cli: receivers, bound accounts and what the
 * session sends. A throwaway CLAUDE_CONFIG_DIR carries a fake remote-settings.json with a
 * header value that must NEVER show up in any output.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, fakeEnv, hasCli, makeSandbox } from './harness.js'

const SECRET = 'SECRETO'

function run(args: string[], configDir: string, cwd: string, extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync([CLI, ...args], {
    cwd,
    stdin: new Uint8Array(),
    env: { ...fakeEnv('http://127.0.0.1:9/v1', configDir, extra), CLAUDE_CODE_ENABLE_TELEMETRY: '', OTEL_EXPORTER_OTLP_HEADERS: '' },
  })
  return { out: proc.stdout.toString() + proc.stderr.toString(), code: proc.exitCode }
}

describe.skipIf(!hasCli)('/otel e2e', () => {
  const { configDir, cwd } = makeSandbox()
  writeFileSync(
    join(configDir, 'remote-settings.json'),
    JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.datadoghq.eu',
        OTEL_EXPORTER_OTLP_HEADERS: `dd-api-key=${SECRET}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=production',
      },
    }),
  )

  test('-p "/otel": sin receptor ligado a la cuenta, destino y origen, cabecera enmascarada', () => {
    const { out, code } = run(['-p', '/otel'], configDir, cwd, { OTEL_EXPORTER_OTLP_METRICS_HEADERS: `x-token=${SECRET}` })
    expect(code).toBe(0)
    expect(out).toContain('No se envía nada: ningún receptor está ligado a la cuenta custom')
    expect(out).toContain('https://otlp.datadoghq.eu')
    expect(out).toContain('dd-api-key=***')
    expect(out).toContain('remote-settings de la organización')
    expect(out).toContain('(ninguno; los propios se declaran en')
    expect(out).not.toContain(SECRET)
  })

  test('/telemetry --json y el alias /opentelemetry: JSON válido sin el secreto', () => {
    for (const cmd of ['/telemetry --json', '/opentelemetry --json']) {
      const { out } = run(['-p', cmd], configDir, cwd)
      expect(out).not.toContain(SECRET)
      const j = JSON.parse(out)
      expect(j.buildEnabled).toBe(true)
      expect(j.sends).toBe(false)
      expect(j.sinksBlock.sinks).toEqual([])
      expect(j.destinations.find((d: { signal: string }) => d.signal === 'metrics')).toMatchObject({ otlp: true, headers: ['dd-api-key'] })
    }
  })

  test('receptores propios de <config>/telemetry.json: cuentas ligadas y sin credenciales', () => {
    const own = makeSandbox()
    writeFileSync(join(own.configDir, 'telemetry.json'), JSON.stringify({ sinks: { propio: { endpoint: 'http://127.0.0.1:9', protocol: 'http/json', accounts: ['custom', 'otra'], headersRef: "env:FNH_NO_EXISTE", headersAs: 'bearer' } } }))
    const { out } = run(['-p', '/otel'], own.configDir, own.cwd)
    expect(out).toContain('Se envía telemetría de la cuenta custom a: propio (http://127.0.0.1:9)')
    expect(out).toContain('propio [propio · recibe esta sesión]')
    expect(out).toContain('cuentas ligadas: custom, otra')
    expect(out).toContain('credenciales: sí (ocultas)')
    expect(out).not.toContain(SECRET)
  })

  test('/telemetry add escribe telemetry.json (0600, con copia) y /telemetry test falla limpio si el receptor no responde', () => {
    const own = makeSandbox()
    const add = run(['-p', '/telemetry add local http://127.0.0.1:9 --accounts custom'], own.configDir, own.cwd)
    expect(add.out).toContain('Receptor "local" guardado')
    const path = join(own.configDir, 'telemetry.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).sinks.local.accounts).toEqual(['custom'])
    const again = run(['-p', '/telemetry add otro http://127.0.0.1:9 --accounts custom'], own.configDir, own.cwd)
    expect(again.out).toContain('copia previa:')
    expect(run(['-p', '/telemetry add malo http://127.0.0.1:9'], own.configDir, own.cwd).out).toContain('falta --accounts')
    const test = run(['-p', '/telemetry test local'], own.configDir, own.cwd)
    expect(test.out).toMatch(/^FALLO: /)
    expect(run(['-p', '/telemetry test nadie'], own.configDir, own.cwd).out).toContain('no existe el receptor "nadie"')
  }, 30_000)
})
