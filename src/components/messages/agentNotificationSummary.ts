/**
 * Display text for a background-agent task notification. The model receives
 * `Agent "x" completed`; the transcript shows the shorter Claude Code 2.1.310
 * form `Agent "x" finished · 11s` (duration taken from <duration_ms> when known).
 */

export function formatShortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

export function displayAgentSummary(summary: string, durationMs?: number | null): string {
  const m = /^Agent "(.*)" completed$/s.exec(summary)
  if (!m) return summary
  const suffix = durationMs != null && Number.isFinite(durationMs) ? ` · ${formatShortDuration(durationMs)}` : ''
  return `Agent "${m[1]}" finished${suffix}`
}
