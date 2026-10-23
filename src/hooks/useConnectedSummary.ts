import { useEffect, useState } from 'react'
import {
  applyMockOverride,
  computeConnectedSummary,
  type ConnectedSummary,
} from '../services/api/openai-compat/connected.js'

let lastSummary: ConnectedSummary | null = null
let lastAt = 0
const REUSE_MS = 30_000

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
