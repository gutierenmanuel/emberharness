/**
 * The OpenTelemetry SDK side of one receiver: its own MeterProvider and
 * LoggerProvider, with their OTLP exporters. This is the only module that
 * imports the SDK (about 1 MB), so sinkRuntime.ts loads it lazily, the first
 * time a receiver is actually used.
 *
 * Each receiver gets its own providers (and resource), so what one receiver
 * is sent can never reach another, and one receiver being down never delays
 * the others.
 */

import type { Logger } from '@opentelemetry/api-logs'
import type { Meter } from '@opentelemetry/api'
import { AggregationTemporalityPreference, OTLPMetricExporter as JsonMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPMetricExporter as ProtoMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter as JsonLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPLogExporter as ProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import type { Signal, SinkDef } from './sinks.js'

export type ExportResult = { ok: boolean; error?: string }

export type SinkProviders = {
  meter: Meter | null
  logger: Logger | null
  /** Exports whatever is pending now. Never rejects. */
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

const EXPORT_TIMEOUT_MS = 5_000
const SCOPE = 'com.anthropic.claude_code'

type Callback = (r: { code: number; error?: Error }) => void
type Exportable = { export: (items: unknown, cb: Callback) => void }

/** Wraps `exporter.export` so every outcome is reported to `onResult` (code 0 = success). */
function observe(exporter: Exportable, signal: Signal, onResult: (signal: Signal, r: ExportResult) => void): void {
  const original = exporter.export.bind(exporter)
  exporter.export = (items, cb) => {
    try {
      original(items, r => {
        onResult(signal, r.code === 0 ? { ok: true } : { ok: false, error: r.error?.message ?? 'exportación fallida' })
        cb(r)
      })
    } catch (e) {
      onResult(signal, { ok: false, error: (e as Error).message })
      cb({ code: 1, error: e as Error })
    }
  }
}

export function buildProviders(
  def: SinkDef,
  headers: Record<string, string>,
  version: string,
  onResult: (signal: Signal, r: ExportResult) => void,
): SinkProviders {
  const resource = resourceFromAttributes({ ...def.resourceAttributes })
  let meterProvider: MeterProvider | null = null
  let loggerProvider: LoggerProvider | null = null

  const m = def.signals.metrics
  if (m) {
    const options = {
      url: m.url,
      headers,
      timeoutMillis: EXPORT_TIMEOUT_MS,
      temporalityPreference: def.temporality === 'cumulative' ? AggregationTemporalityPreference.CUMULATIVE : AggregationTemporalityPreference.DELTA,
    }
    const exporter = m.protocol === 'http/protobuf' ? new ProtoMetricExporter(options) : new JsonMetricExporter(options)
    observe(exporter as unknown as Exportable, 'metrics', onResult)
    meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: m.intervalMs, exportTimeoutMillis: Math.min(m.intervalMs, EXPORT_TIMEOUT_MS) })],
    })
  }

  const l = def.signals.logs
  if (l) {
    const options = { url: l.url, headers, timeoutMillis: EXPORT_TIMEOUT_MS }
    const exporter = l.protocol === 'http/protobuf' ? new ProtoLogExporter(options) : new JsonLogExporter(options)
    observe(exporter as unknown as Exportable, 'logs', onResult)
    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: l.intervalMs, exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
    })
  }

  const settle = async (p: Promise<unknown> | undefined) => {
    try {
      await p
    } catch {
      // The outcome was already reported through observe().
    }
  }
  return {
    meter: meterProvider ? meterProvider.getMeter(SCOPE, version) : null,
    logger: loggerProvider ? loggerProvider.getLogger(`${SCOPE}.events`, version) : null,
    forceFlush: async () => {
      await Promise.all([settle(meterProvider?.forceFlush()), settle(loggerProvider?.forceFlush())])
    },
    shutdown: async () => {
      await Promise.all([settle(meterProvider?.shutdown()), settle(loggerProvider?.shutdown())])
    },
  }
}
