/**
 * `/otel` against the real ./cli: read-only report of what telemetry does and where it
 * would go. A throwaway CLAUDE_CONFIG_DIR carries a fake remote-settings.json with a
 * header value that must NEVER show up in any output.
 */

import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
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

  test('-p "/otel": build apagado, destino y origen, cabecera enmascarada', () => {
    const { out, code } = run(['-p', '/otel'], configDir, cwd, { OTEL_EXPORTER_OTLP_METRICS_HEADERS: `x-token=${SECRET}` })
    expect(code).toBe(0)
    expect(out).toContain('No se envía nada: telemetría desactivada en este build')
    expect(out).toContain('https://otlp.datadoghq.eu')
    expect(out).toContain('dd-api-key=***')
    expect(out).toContain('remote-settings de la organización')
    expect(out).toContain('no hay ninguno configurado')
    expect(out).not.toContain(SECRET)
  })

  test('/telemetry --json y el alias /opentelemetry: JSON válido sin el secreto', () => {
    for (const cmd of ['/telemetry --json', '/opentelemetry --json']) {
      const { out } = run(['-p', cmd], configDir, cwd)
      expect(out).not.toContain(SECRET)
      const j = JSON.parse(out)
      expect(j.buildEnabled).toBe(false)
      expect(j.sends).toBe(false)
      expect(j.destinations.find((d: { signal: string }) => d.signal === 'metrics')).toMatchObject({ otlp: true, headers: ['dd-api-key'] })
    }
  })

  test('receptores propios de <config>/telemetry.json', () => {
    const own = makeSandbox()
    writeFileSync(join(own.configDir, 'telemetry.json'), JSON.stringify({ sinks: { propio: { endpoint: 'http://127.0.0.1:4318', protocol: 'http/json', accounts: '*', headersRef: `pass:${SECRET}` } } }))
    const { out } = run(['-p', '/otel'], own.configDir, own.cwd)
    expect(out).toContain('propio: http://127.0.0.1:4318')
    expect(out).not.toContain(SECRET)
  })
})
