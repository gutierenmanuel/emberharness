/**
 * Telemetry context of one measurement (pure, no I/O).
 *
 * Every counter increment and every event belongs to ONE account: the one
 * that served the request (the request scope's account, e.g. a subagent
 * `claude-work:sonnet`) or, outside any scope, the session's. That account
 * decides which receivers see the measurement (sinks.ts, `sinksFor`) and whose
 * identity the attributes carry.
 *
 * The impure part (reading the request scope, accounts.json, `~/.fn_pc`)
 * lives in sinkRuntime.ts and hands its findings to `resolveTelemetryCtx`.
 */

export type AccountKind = 'anthropic' | 'openai_compat' | 'local'

export type TelemetryCtx = {
  /** Account that served the request (or the session's, outside a scope). */
  account: string
  accountKind: AccountKind
  /** Host of the model backend, or `api.anthropic.com`. */
  backend: string
  /** Model without the `account:` prefix, when known. */
  model: string | undefined
  /** The request's account differs from the session's. */
  routed: boolean
  sessionAccount: string
  /** Subagent type name, when inside a subagent. */
  agentType: string | undefined
}

export type CtxInput = {
  /** Account of the live request scope, if any. */
  scopedAccount?: string
  /** Account of the session (FNHARNESS_ACCOUNT, default `claude`). */
  sessionAccount: string
  /** `anthropic` or `openai_compat`, from accounts.json (the implicit `claude` is anthropic). */
  kindOf: (id: string) => 'anthropic' | 'openai_compat'
  /** Configured base URL of an account (OpenAI-compatible endpoint, or a Claude proxy). */
  baseUrlOf: (id: string) => string | undefined
  /** Model argument, possibly `account:model`. */
  model?: string
  agentType?: string
}

/** localhost, loopback, RFC1918 and `.local`/`.lan` names: a server on this machine or LAN. */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** `host[:port]` of a URL, or null when it does not parse. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** `claude-work:sonnet` -> `sonnet`; a model without a prefix stays as is. */
export function stripAccountPrefix(model: string | undefined, accountIds: Iterable<string> = []): string | undefined {
  if (!model) return model
  const i = model.indexOf(':')
  if (i <= 0) return model
  const prefix = model.slice(0, i)
  for (const id of accountIds) if (id === prefix) return model.slice(i + 1)
  // Unknown prefix: a Claude/Ollama tag such as `qwen3:8b` keeps its colon.
  return model
}

export function resolveTelemetryCtx(input: CtxInput, knownAccounts: Iterable<string> = []): TelemetryCtx {
  const account = input.scopedAccount ?? input.sessionAccount
  const baseUrl = input.baseUrlOf(account)
  const host = hostOf(baseUrl)
  const kind = input.kindOf(account)
  const accountKind: AccountKind = kind === 'anthropic' ? 'anthropic' : host && isLocalHost(host.replace(/:\d+$/, '')) ? 'local' : 'openai_compat'
  return {
    account,
    accountKind,
    backend: host ?? 'api.anthropic.com',
    model: stripAccountPrefix(input.model, knownAccounts),
    routed: account !== input.sessionAccount,
    sessionAccount: input.sessionAccount,
    agentType: input.agentType,
  }
}
