import { describe, expect, test } from 'bun:test'
import {
  buildOtelReport,
  displayValue,
  formatOtelReport,
  maskOtelHeaders,
  maskUrl,
  parseOwnSinks,
  type EnvLayer,
  type OtelReportInput,
} from './otelReport.js'

const SECRET = 'SECRETO-1234'

const account = { id: 'claude', label: 'Claude', provider: null, email: 'persona@example.com', org: 'Acme' }
const noSinks = parseOwnSinks('/cfg/telemetry.json', null)

const remote: EnvLayer = {
  origin: 'remote-settings',
  label: 'remote-settings de la organización',
  env: {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.datadoghq.eu',
    OTEL_EXPORTER_OTLP_HEADERS: `dd-api-key=${SECRET}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=production',
  },
}
const userSettings: EnvLayer = { origin: 'settings', label: 'settings.json (env)', env: { OTEL_METRIC_EXPORT_INTERVAL: '15000' } }

function input(over: Partial<OtelReportInput> = {}): OtelReportInput {
  return { buildEnabled: false, account, layers: [remote, userSettings], processEnv: {}, ownSinks: noSinks, ...over }
}

describe('enmascarado', () => {
  test('las cabeceras conservan solo el nombre', () => {
    expect(maskOtelHeaders(`dd-api-key=${SECRET}, x-org=7`)).toBe('dd-api-key=***,x-org=***')
    expect(maskOtelHeaders('sinigual')).toBe('***')
    expect(maskOtelHeaders(`a=b=${SECRET}`)).not.toContain(SECRET)
  })

  test('la URL pierde credenciales y query', () => {
    expect(maskUrl(`https://u:${SECRET}@host.example:4318/v1?api_key=${SECRET}`)).toBe('https://host.example:4318/v1')
    expect(maskUrl('https://otlp.datadoghq.eu')).toBe('https://otlp.datadoghq.eu')
  })

  test('displayValue oculta cabeceras, nombres con key/token y atributos sensibles', () => {
    expect(displayValue('OTEL_EXPORTER_OTLP_METRICS_HEADERS', `k=${SECRET}`)).toEqual({ value: 'k=***', masked: true })
    expect(displayValue('OTEL_X_API_TOKEN', SECRET)).toEqual({ value: '***', masked: true })
    expect(displayValue('OTEL_RESOURCE_ATTRIBUTES', `env=prod,api.key=${SECRET}`)).toEqual({ value: 'env=prod,api.key=***', masked: true })
    expect(displayValue('OTEL_METRICS_EXPORTER', 'otlp')).toEqual({ value: 'otlp', masked: false })
  })

  test('ni el texto ni el JSON del informe contienen el secreto', () => {
    const r = buildOtelReport(input({ processEnv: { OTEL_EXPORTER_OTLP_METRICS_HEADERS: `x=${SECRET}` } }))
    expect(formatOtelReport(r)).not.toContain(SECRET)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(formatOtelReport(r)).toContain('dd-api-key=***')
  })
})

describe('origen de cada variable', () => {
  test('gana la capa de mayor precedencia', () => {
    const r = buildOtelReport(
      input({
        layers: [remote, { origin: 'settings', label: 'settings.json (env)', env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_METRIC_EXPORT_INTERVAL: '15000' } }],
        processEnv: { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_TRACES_EXPORTER: 'console' },
      }),
    )
    const by = (n: string) => r.vars.find(v => v.name === n)!
    expect(by('OTEL_EXPORTER_OTLP_PROTOCOL').originLabel).toBe('remote-settings de la organización')
    expect(by('OTEL_EXPORTER_OTLP_PROTOCOL').value).toBe('http/protobuf')
    expect(by('OTEL_METRIC_EXPORT_INTERVAL').origin).toBe('settings')
    expect(by('OTEL_TRACES_EXPORTER').origin).toBe('process-env')
  })

  test('el perfil de cuenta pone DISABLE_TELEMETRY solo si nadie más lo define', () => {
    const profile = { profileEnv: { DISABLE_TELEMETRY: '1' }, profileLabel: 'perfil de la cuenta qwen36', processEnv: { DISABLE_TELEMETRY: '1' } }
    const r = buildOtelReport(input({ layers: [], ...profile }))
    expect(r.vars.find(v => v.name === 'DISABLE_TELEMETRY')).toMatchObject({ origin: 'account-profile', originLabel: 'perfil de la cuenta qwen36' })
    const over = buildOtelReport(input({ layers: [{ origin: 'settings', label: 'settings.json (env)', env: { DISABLE_TELEMETRY: '1' } }], ...profile }))
    expect(over.vars.find(v => v.name === 'DISABLE_TELEMETRY')!.origin).toBe('settings')
  })
})

describe('build apagado frente a encendido', () => {
  test('build apagado: no se envía nada, pero dice a dónde iría', () => {
    const r = buildOtelReport(input({ buildEnabled: false }))
    expect(r.requested).toBe(true)
    expect(r.sends).toBe(false)
    expect(r.verdict).toContain('No se envía nada: telemetría desactivada en este build')
    expect(r.verdict).toContain('https://otlp.datadoghq.eu')
  })

  test('build encendido con la config de empresa: se envía', () => {
    const r = buildOtelReport(input({ buildEnabled: true }))
    expect(r.sends).toBe(true)
    expect(r.verdict).toBe('Se envía telemetría OTLP a https://otlp.datadoghq.eu.')
  })

  test('DISABLE_TELEMETRY apaga aunque el build y la empresa pidan enviar', () => {
    const r = buildOtelReport(input({ buildEnabled: true, processEnv: { DISABLE_TELEMETRY: '1' } }))
    expect(r.sends).toBe(false)
    expect(r.verdict).toContain('DISABLE_TELEMETRY')
  })

  test('sin CLAUDE_CODE_ENABLE_TELEMETRY ni exportadores no hay destino', () => {
    const r = buildOtelReport(input({ buildEnabled: true, layers: [] }))
    expect(r.sends).toBe(false)
    expect(r.destinations.every(d => !d.otlp)).toBe(true)
    expect(r.verdict).toContain('CLAUDE_CODE_ENABLE_TELEMETRY no está activo')
  })
})

describe('destinos', () => {
  test('exportadores, protocolo, intervalo y atributos de recurso', () => {
    const r = buildOtelReport(input())
    const m = r.destinations.find(d => d.signal === 'metrics')!
    expect(m).toMatchObject({ otlp: true, endpoint: 'https://otlp.datadoghq.eu', protocol: 'http/protobuf', protocolIsDefault: false, intervalMs: 15000, intervalIsDefault: false, headers: ['dd-api-key'] })
    const l = r.destinations.find(d => d.signal === 'logs')!
    expect(l).toMatchObject({ otlp: true, intervalMs: 5000, intervalIsDefault: true })
    expect(r.destinations.find(d => d.signal === 'traces')!.otlp).toBe(false)
    expect(r.resourceAttributes).toEqual([{ key: 'deployment.environment', value: 'production' }])
  })

  test('el endpoint por señal gana al general', () => {
    const r = buildOtelReport(input({ processEnv: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318' } }))
    expect(r.destinations.find(d => d.signal === 'logs')!.endpoint).toBe('http://127.0.0.1:4318')
    expect(r.destinations.find(d => d.signal === 'metrics')!.endpoint).toBe('https://otlp.datadoghq.eu')
  })
})

describe('receptores propios', () => {
  test('sin fichero lo dice', () => {
    expect(formatOtelReport(buildOtelReport(input()))).toContain('no hay ninguno configurado')
  })

  test('lista los receptores sin mostrar la referencia de cabeceras', () => {
    const text = JSON.stringify({ sinks: { propio: { endpoint: 'http://127.0.0.1:4318', protocol: 'http/json', accounts: '*', schema: 'enriched' }, x: { endpoint: 'https://o.example', headersRef: 'pass:apis/secreto', accounts: ['a', 'b'] } } })
    const own = parseOwnSinks('/cfg/telemetry.json', text)
    expect(own.sinks.map(s => s.id)).toEqual(['propio', 'x'])
    expect(own.sinks[1]).toMatchObject({ accounts: 'a, b', hasHeaders: true })
    const out = formatOtelReport(buildOtelReport(input({ ownSinks: own })))
    expect(out).toContain('propio: http://127.0.0.1:4318')
    expect(out).not.toContain('apis/secreto')
  })

  test('JSON roto se informa, no revienta', () => {
    expect(parseOwnSinks('/c/telemetry.json', '{nope').error).toContain('JSON inválido')
    expect(parseOwnSinks('/c/telemetry.json', '{}').error).toContain('sinks')
  })
})
