/**
 * Speed metrics for LOCAL OpenAI-compatible backends (llama.cpp, qwen36 via
 * llm-tap, ollama, LM Studio).
 *
 * llama-server returns a `timings` object in the last streaming chunk
 * (`prompt_n`, `prompt_ms`, `predicted_n`, `predicted_ms`, `cache_n` and, with
 * speculative decoding, `draft_n` / `draft_n_accepted`). When the server does
 * not send it (ollama, LM Studio) we fall back to what the client can measure:
 * time to first token and the token counts from `usage`.
 *
 * Everything here is pure except the small sample buffer at the bottom, which
 * the adapter fills per request and the REPL / QueryEngine drain once per turn.
 * Set FNHARNESS_LOCAL_SPEED=0 to turn the whole feature off.
 */

export type RawTimings = Record<string, unknown> | null | undefined

export type SpeedSample = {
  /** Time to first token (any delta: thinking, text or tool call), ms. */
  ttftMs: number | null
  /** Wall time of the whole request, ms. */
  totalMs: number
  /** Prompt tokens evaluated by the server (excludes cached ones when known). */
  promptN: number | null
  /** Prompt tokens served from the KV cache. */
  cacheN: number | null
  promptMs: number | null
  predictedN: number | null
  predictedMs: number | null
  draftN: number | null
  draftAccepted: number | null
  /** The request carried tools, i.e. it belongs to the agent loop (not a title/summary side query). */
  withTools: boolean
  /** 'server' = llama.cpp `timings`; 'client' = measured by us. */
  source: 'server' | 'client'
}

export type SpeedSummary = {
  requests: number
  ttftMs: number | null
  promptN: number | null
  cacheN: number | null
  /** Prefill speed, tok/s. */
  promptTps: number | null
  predictedN: number | null
  /** Generation speed, tok/s. */
  predictedTps: number | null
  draftN: number | null
  draftAccepted: number | null
  source: 'server' | 'client'
}

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  return !!baseUrl && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl)
}

export function localSpeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.FNHARNESS_LOCAL_SPEED
  return !(v === '0' || v === 'false' || v === 'off')
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Builds one sample from the server `timings` (preferred), the `usage` object
 * and the client-side clock. Returns null when there is nothing to report.
 */
export function buildSpeedSample(input: {
  timings?: RawTimings
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  ttftMs: number | null
  totalMs: number
  withTools?: boolean
}): SpeedSample | null {
  const t = input.timings ?? null
  if (t && (num(t.predicted_n) !== null || num(t.prompt_n) !== null)) {
    return {
      ttftMs: input.ttftMs,
      totalMs: input.totalMs,
      promptN: num(t.prompt_n),
      cacheN: num(t.cache_n),
      promptMs: num(t.prompt_ms),
      predictedN: num(t.predicted_n),
      predictedMs: num(t.predicted_ms),
      draftN: num(t.draft_n),
      draftAccepted: num(t.draft_n_accepted),
      withTools: input.withTools ?? true,
      source: 'server',
    }
  }
  const promptTokens = num(input.usage?.prompt_tokens)
  const completionTokens = num(input.usage?.completion_tokens)
  if (input.ttftMs === null && promptTokens === null && completionTokens === null) return null
  // Client fallback: the wait until the first token approximates prefill, the
  // rest of the request approximates generation.
  const genMs = input.ttftMs !== null ? Math.max(input.totalMs - input.ttftMs, 0) : null
  return {
    ttftMs: input.ttftMs,
    totalMs: input.totalMs,
    promptN: promptTokens,
    cacheN: null,
    promptMs: input.ttftMs,
    predictedN: completionTokens,
    predictedMs: genMs,
    draftN: null,
    draftAccepted: null,
    withTools: input.withTools ?? true,
    source: 'client',
  }
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function rate(n: number | null, ms: number | null): number | null {
  return n !== null && ms !== null && ms > 0 ? (n / ms) * 1000 : null
}

/**
 * Folds the requests of one turn (tool loops make several) into one summary.
 * Side queries without tools (titles, summaries) are left out when the agent
 * loop itself produced samples.
 */
export function summarizeSamples(all: readonly SpeedSample[]): SpeedSummary | null {
  const main = all.filter(s => s.withTools)
  const samples = main.length ? main : all
  if (!samples.length) return null
  const ttfts = samples.map(s => s.ttftMs).filter((v): v is number => v !== null)
  const promptN = sum(samples.map(s => s.promptN))
  const predictedN = sum(samples.map(s => s.predictedN))
  return {
    requests: samples.length,
    ttftMs: ttfts.length ? median(ttfts) : null,
    promptN,
    cacheN: sum(samples.map(s => s.cacheN)),
    promptTps: rate(promptN, sum(samples.map(s => s.promptMs))),
    predictedN,
    predictedTps: rate(predictedN, sum(samples.map(s => s.predictedMs))),
    draftN: sum(samples.map(s => s.draftN)),
    draftAccepted: sum(samples.map(s => s.draftAccepted)),
    source: samples.every(s => s.source === 'server') ? 'server' : 'client',
  }
}

function fmtRate(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1)
}

/** One dim line for the TUI, e.g. `TTFT 0.42 s · lectura 1520 tok/s (…)`. */
export function formatSpeedLine(s: SpeedSummary): string {
  const parts: string[] = []
  if (s.ttftMs !== null) parts.push(`TTFT ${(s.ttftMs / 1000).toFixed(2)} s`)
  if (s.promptN !== null) {
    const speed = s.promptTps !== null ? `${fmtRate(s.promptTps)} tok/s ` : ''
    const cached = s.cacheN ? `, ${s.cacheN} en caché` : ''
    parts.push(`lectura ${speed}(${s.promptN} tok${cached})`)
  } else if (s.cacheN) {
    parts.push(`lectura (${s.cacheN} tok en caché)`)
  }
  if (s.predictedN !== null) {
    const speed = s.predictedTps !== null ? `${fmtRate(s.predictedTps)} tok/s ` : ''
    parts.push(`generación ${speed}(${s.predictedN} tok)`)
  }
  if (s.draftN) {
    const acc = s.draftAccepted ?? 0
    parts.push(`especulación ${Math.round((acc / s.draftN) * 100)}% (${acc}/${s.draftN})`)
  }
  if (s.source === 'client') parts.push('medido en cliente')
  if (s.requests > 1) parts.push(`${s.requests} peticiones`)
  return parts.join(' · ')
}

/** JSON-friendly shape for `-p --output-format json` (`local_speed`). */
export function speedSummaryToJson(s: SpeedSummary): Record<string, unknown> {
  return {
    requests: s.requests,
    source: s.source,
    ttft_s: s.ttftMs !== null ? Number((s.ttftMs / 1000).toFixed(3)) : null,
    prompt_tokens: s.promptN,
    prompt_cached_tokens: s.cacheN,
    prompt_tokens_per_second: s.promptTps !== null ? Number(s.promptTps.toFixed(2)) : null,
    generated_tokens: s.predictedN,
    generation_tokens_per_second: s.predictedTps !== null ? Number(s.predictedTps.toFixed(2)) : null,
    draft_tokens: s.draftN,
    draft_accepted_tokens: s.draftAccepted,
  }
}

// --- sample buffer (the only state) -----------------------------------------

let buffer: SpeedSample[] = []

export function recordSpeedSample(sample: SpeedSample): void {
  buffer.push(sample)
}

/** Returns the samples gathered since the last drain and empties the buffer. */
export function drainSpeedSamples(): SpeedSample[] {
  const out = buffer
  buffer = []
  return out
}

/** Drains the buffer and returns its summary (null when empty or disabled). */
export function drainSpeedSummary(): SpeedSummary | null {
  const samples = drainSpeedSamples()
  return localSpeedEnabled() ? summarizeSamples(samples) : null
}
