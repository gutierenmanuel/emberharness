import { describe, expect, test } from 'bun:test'
import {
  buildOtelReport,
  displayValue,
  formatOtelReport,
  maskOtelHeaders,
  maskUrl,
  type EnvLayer,
  type OtelReportInput,
  type SinksBlock,
} from './otelReport.js'
import type { SinkInfo } from './sinks.js'

const SECRET = 'SECRETO-1234'

const account = { id: 'claude', label: 'Claude', provider: null, email: 'persona@example.com', org: 'Acme' }
const noSinks: SinksBlock = { path: '/cfg/telemetry.json', present: false, errors: [], sinks: [], humanDisabled: false }
const sink = (over: Partial<SinkInfo> = {}): SinkInfo => ({
  id: 'otel-3amdata',
  origin: 'user',
  endpoint: 'https://otel.3amdata.win',
  protocol: 'http/json',
  schema: 'enriched',
  accounts: ['claude', 'qwen36'],
  enabled: true,
  disabledReason: null,
  activeForSession: true,
  signals: ['metrics', 'logs'],
  prompts: false,
  toolDetails: false,
  hasCredentials: true,
  status: null,
  ...over,
})

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
  return { buildEnabled: false, account, layers: [remote, userSettings], processEnv: {}, sinksBlock: noSinks, ...over }
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

  test('el perfil de cuenta marca FNHARNESS_PROFILE_NO_TELEMETRY y no toca DISABLE_TELEMETRY', () => {
    const profile = { profileEnv: { FNHARNESS_PROFILE_NO_TELEMETRY: '1' }, profileLabel: 'perfil de la cuenta qwen36', processEnv: { FNHARNESS_PROFILE_NO_TELEMETRY: '1' } }
    const r = buildOtelReport(input({ layers: [], ...profile }))
    expect(r.vars.find(v => v.name === 'FNHARNESS_PROFILE_NO_TELEMETRY')).toMatchObject({ origin: 'account-profile', originLabel: 'perfil de la cuenta qwen36' })
    expect(r.vars.find(v => v.name === 'DISABLE_TELEMETRY')).toBeUndefined()
    expect(r.sends).toBe(false)
  })
})

describe('veredicto según los receptores ligados', () => {
  test('sin receptores ligados a la cuenta: no se envía nada', () => {
    const r = buildOtelReport(input({ buildEnabled: true }))
    expect(r.sends).toBe(false)
    expect(r.verdict).toBe('No se envía nada: ningún receptor está ligado a la cuenta claude.')
  })

  test('un receptor ligado a la cuenta de la sesión: se envía', () => {
    const r = buildOtelReport(input({ buildEnabled: true, sinksBlock: { ...noSinks, present: true, sinks: [sink()] } }))
    expect(r.sends).toBe(true)
    expect(r.verdict).toBe('Se envía telemetría de la cuenta claude a: otel-3amdata (https://otel.3amdata.win).')
  })

  test('un receptor ligado a otra cuenta no cuenta para esta sesión', () => {
    const r = buildOtelReport(input({ buildEnabled: true, sinksBlock: { ...noSinks, sinks: [sink({ activeForSession: false })] } }))
    expect(r.sends).toBe(false)
  })

  test('DISABLE_TELEMETRY de la persona apaga los propios y lo dice', () => {
    const r = buildOtelReport(input({ buildEnabled: true, sinksBlock: { ...noSinks, humanDisabled: true, sinks: [sink({ enabled: false, activeForSession: false, disabledReason: 'DISABLE_TELEMETRY activo' })] } }))
    expect(r.sends).toBe(false)
    expect(r.verdict).toContain('DISABLE_TELEMETRY')
  })

  test('los ajustes de la organización piden telemetría pero no hay receptor: solo informa', () => {
    const r = buildOtelReport(input({ buildEnabled: true }))
    expect(r.requested).toBe(true)
    expect(r.destinations.find(d => d.signal === 'metrics')!.otlp).toBe(true)
  })

  test('sin CLAUDE_CODE_ENABLE_TELEMETRY ni exportadores no hay destino', () => {
    const r = buildOtelReport(input({ buildEnabled: true, layers: [] }))
    expect(r.destinations.every(d => !d.otlp)).toBe(true)
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

describe('bloque de receptores', () => {
  test('sin ninguno lo dice y señala el fichero', () => {
    expect(formatOtelReport(buildOtelReport(input()))).toContain('(ninguno; los propios se declaran en /cfg/telemetry.json, que no existe)')
  })

  test('lista receptores con cuentas ligadas, último envío y error, sin credenciales', () => {
    const when = Date.UTC(2026, 10, 13, 10, 20, 30)
    const sinks = [
      sink({ status: { lastOkAt: when, lastError: null, lastErrorAt: null, ok: 3, failed: 0, blocked: null } }),
      sink({ id: 'claude-work:otlp.datadoghq.eu', origin: 'managed', endpoint: 'https://otlp.datadoghq.eu', protocol: 'http/protobuf', schema: 'official', accounts: ['claude-work'], activeForSession: false, status: { lastOkAt: null, lastError: 'metrics: connect ECONNREFUSED', lastErrorAt: when, ok: 0, failed: 1, blocked: null } }),
    ]
    const out = formatOtelReport(buildOtelReport(input({ buildEnabled: true, sinksBlock: { ...noSinks, present: true, sinks } })))
    expect(out).toContain('otel-3amdata [propio · recibe esta sesión]')
    expect(out).toContain('cuentas ligadas: claude, qwen36')
    expect(out).toContain('último envío correcto: 10:20:30 UTC')
    expect(out).toContain('claude-work:otlp.datadoghq.eu [organización · ligado, no recibe esta sesión]')
    expect(out).toContain('último error: metrics: connect ECONNREFUSED')
    expect(out).toContain('credenciales: sí (ocultas)')
  })

  test('un aviso de telemetry.json se muestra, no revienta', () => {
    const out = formatOtelReport(buildOtelReport(input({ sinksBlock: { ...noSinks, present: true, errors: ['x: falta "accounts"'] } })))
    expect(out).toContain('aviso en /cfg/telemetry.json: x: falta "accounts"')
  })
})
