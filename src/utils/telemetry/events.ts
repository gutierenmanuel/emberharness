/**
 * Telemetry events (`logOTelEvent`). Delivery and per-receiver redaction live
 * in sinkRuntime.ts / sinks.ts; this is the call-site API.
 */

import { PROMPT_MARK, REDACTED } from './sinks.js'
import { emitEvent, promptsWanted } from './sinkRuntime.js'

/**
 * Prompt text for an event. Each receiver decides for itself (its own
 * `logUserPrompts`), so when at least one receiver reached by this request
 * wants prompts the text travels marked and sinkRuntime unmarks or redacts it
 * per receiver; when none wants it, it never leaves this function.
 */
export function redactIfDisabled(content: string): string {
  return promptsWanted() ? PROMPT_MARK + content : REDACTED
}

export async function logOTelEvent(
  eventName: string,
  metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  emitEvent(eventName, metadata)
}
