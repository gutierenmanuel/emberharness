/**
 * Client version announced to the Anthropic API (User-Agent and cc_version).
 *
 * The fork is built from the Claude Code 2.1.87 snapshot (MACRO.VERSION, still
 * used for the UI, changelog and update checks), but Anthropic rejects the 5.x
 * models for clients older than 2.1.280 with `claude_code_version_too_old`.
 * The wire version is therefore the highest of the two, and can be overridden
 * with FNHARNESS_API_VERSION when the minimum moves again.
 */
export const MIN_API_CLIENT_VERSION = '2.1.280'

function parse(v: string): number[] {
  return v.split('-')[0]!.split('.').map(n => Number.parseInt(n, 10) || 0)
}

function isNewer(a: string, b: string): boolean {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

export function getWireVersion(): string {
  const override = process.env.FNHARNESS_API_VERSION
  if (override && /^\d+\.\d+\.\d+/.test(override)) return override
  // MACRO is injected by the bundler; unit tests run without it.
  const base = typeof MACRO === 'undefined' ? '0.0.0' : MACRO.VERSION
  return isNewer(base, MIN_API_CLIENT_VERSION) ? base : MIN_API_CLIENT_VERSION
}
