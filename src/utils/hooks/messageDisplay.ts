// MessageDisplay hook plumbing for the interactive UI: runs the hook once per
// finished assistant message and caches the replacement text so the renderer
// can show it. Display only; transcript and model keep the original text.

import { createHash } from 'crypto'
import { useEffect, useSyncExternalStore } from 'react'
import { createSignal } from '../signal.js'
import { randomUUID } from '../crypto.js'
import { hasHooksForEvent } from '../hooks.js'

const MAX_ENTRIES = 500
// text -> replacement (undefined = hook ran and kept the original)
const results = new Map<string, string | undefined>()
const inFlight = new Set<string>()
const changed = createSignal()
let version = 0
const turnId = randomUUID()

export function messageDisplayKey(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** Pure: stable UUID-shaped id derived from a message's text. */
export function messageIdFor(text: string): string {
  const h = messageDisplayKey(text)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export function resetMessageDisplayForTests(): void {
  results.clear()
  inFlight.clear()
  version++
  changed.emit()
}

/** Kicks off the hook for `text` once; resolves when the replacement is cached. */
export async function ensureMessageDisplay(
  text: string,
  run: (turnId: string, messageId: string, text: string) => Promise<string | undefined>,
): Promise<void> {
  if (results.has(text) || inFlight.has(text)) return
  inFlight.add(text)
  let replacement: string | undefined
  try {
    replacement = await run(turnId, messageIdFor(text), text)
  } catch {
    replacement = undefined
  }
  inFlight.delete(text)
  if (results.size >= MAX_ENTRIES) {
    const first = results.keys().next().value
    if (first !== undefined) results.delete(first)
  }
  results.set(text, replacement)
  version++
  changed.emit()
}

/**
 * Text to render for a finished assistant message. Returns the original until
 * the hook answers; verbose mode always shows the original.
 */
export function useMessageDisplayText(text: string, verbose: boolean): string {
  useSyncExternalStore(changed.subscribe, () => version)
  useEffect(() => {
    if (verbose || !text.trim()) return
    void (async () => {
      const { executeMessageDisplayHooks } = await import('../hooks.js')
      if (!hasHooksForEvent('MessageDisplay')) return
      await ensureMessageDisplay(text, executeMessageDisplayHooks)
    })()
  }, [text, verbose])
  if (verbose || !text.trim()) return text
  if (!results.has(text)) {
    // Hooks configured: show nothing until the hook answers (at most its
    // timeout) so the original never flashes. Without hooks: the original.
    return hasHooksForEvent('MessageDisplay') ? '' : text
  }
  const r = results.get(text)
  return r === undefined ? text : r
}
