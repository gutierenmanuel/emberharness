import { useEffect, useState } from 'react'
import {
  applyMockOverride,
  computeConnectedSummary,
  type ConnectedSummary,
} from '../services/api/openai-compat/connected.js'

let lastSummary: ConnectedSummary | null = null
let lastAt = 0
let pending: Promise<ConnectedSummary | null> | null = null
const REUSE_MS = 30_000

/**
 * Starts the account/model probe as early as possible (entrypoint). The header
 * lives in Ink's static scrollback and is printed once, so the result has to
 * be ready before the REPL first renders: see awaitConnectedSummary.
 */
export function primeConnectedSummary(): void {
  if (pending) return
  pending = computeConnectedSummary()
    .then(s => {
      lastSummary = s
      lastAt = Date.now()
      return s
    })
    .catch(() => null)
}

/** Waits for the primed probe, at most `maxMs`, so startup never stalls on it. */
export async function awaitConnectedSummary(maxMs: number): Promise<void> {
  if (!pending) return
  await Promise.race([pending, new Promise(r => setTimeout(r, maxMs))])
}

/**
 * Header counters: null while the background probe runs (render as "…").
 * Honors globalThis.__FNHARNESS_MOCKS__ accounts/models, re-read on every render.
 */
export function useConnectedSummary(): ConnectedSummary | null {
  const [summary, setSummary] = useState<ConnectedSummary | null>(
    Date.now() - lastAt < REUSE_MS ? lastSummary : null,
  )
  useEffect(() => {
    if (summary) return
    let cancelled = false
    computeConnectedSummary()
      .then(s => {
        lastSummary = s
        lastAt = Date.now()
        if (!cancelled) setSummary(s)
      })
      .catch(() => {
        if (!cancelled) setSummary({ accounts: 0, models: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return applyMockOverride(summary)
}
