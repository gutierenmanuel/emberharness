/**
 * Telemetry entry points. A thin dispatcher: the decisions live in sinks.ts
 * and context.ts, the delivery in sinkRuntime.ts, the SDK in sinkProviders.ts.
 *
 * Telemetry here means OTLP to receivers declared per account (an
 * organisation's managed receiver, or ones in `<config>/telemetry.json`).
 * Nothing is sent unless one is bound to the account that served the request.
 */

import { getSessionCounter } from '../../bootstrap/state.js'
import { flushSinks, installCounters } from './sinkRuntime.js'

export function bootstrapTelemetry(): void {}

export function parseExporterTypes(value: string | undefined): string[] {
  return (value || '')
    .trim()
    .split(',')
    .filter(Boolean)
    .map(token => token.trim())
    .filter(token => token !== 'none')
}

/** This build carries telemetry. Whether anything is SENT depends on the receivers bound to the account. */
export function isTelemetryEnabled(): boolean {
  return true
}

let initialized = false

/** Installs the counters and counts the session. Idempotent; sends nothing when no receiver is bound. */
export async function initializeTelemetry(): Promise<null> {
  if (initialized) return null
  initialized = true
  installCounters()
  getSessionCounter()?.add(1)
  return null
}

/** Sends what is pending, at most 2 s per receiver. */
export async function flushTelemetry(): Promise<void> {
  await flushSinks()
}
