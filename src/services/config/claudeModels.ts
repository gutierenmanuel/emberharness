/**
 * Claude models as data: the family aliases (`sonnet`, `opus`, `haiku`) and the
 * model each resolves to, the /model picker entries, and per model identity,
 * native context window and prices.
 *
 * Defaults live in `config/defaults/claude-models.json`; the user's
 * `<config dir>/claude-models.json` layers over them and hot-reloads (see
 * hotJson.ts). A model only needs to be listed to be priced; one with `tier`,
 * `version` and `apiId` also gets an identity (marketing name, "latest model"
 * line of the system prompt). To adopt a new model: add it under `models` and
 * point the alias at it. No rebuild, no restart.
 *
 * Imports nothing from the harness so modelIdentity.ts can depend on it.
 */

import defaultsJson from '../../config/defaults/claude-models.json'
import { createHotJson, isRecord, num, str } from './hotJson.js'

export type ClaudeTier = 'opus' | 'sonnet' | 'haiku'

/** USD per million tokens. Same shape as `ModelCosts` in modelCost.ts. */
export type ModelPrices = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

export type ClaudeModelData = {
  /** Canonical id without date, e.g. `claude-sonnet-5-5` (the key under `models`). */
  id: string
  tier?: ClaudeTier
  /** Readable version, e.g. `5.5`. */
  version?: string
  /** Id sent to the API when it differs from `id` (e.g. one with a date). */
  apiId?: string
  knowledgeCutoff?: string
  supportsFastMode?: boolean
  /** Native window in tokens; absent = the standard 200k. */
  contextWindow?: number
  pricing?: ModelPrices
  /** Prices while fast mode is active. */
  fastPricing?: ModelPrices
  /** Prompts longer than this many tokens (input plus cache reads and writes) are billed at `longPricing`. */
  longPromptTokens?: number
  longPricing?: ModelPrices
}

export type PickerEntry = { alias: ClaudeTier; description: string }

export type ClaudeModelsConfig = {
  aliases: Partial<Record<ClaudeTier, string>>
  picker: PickerEntry[]
  models: Record<string, ClaudeModelData>
}

const TIERS: readonly ClaudeTier[] = ['opus', 'sonnet', 'haiku']
const WEB_SEARCH_USD = 0.01

function isTier(v: unknown): v is ClaudeTier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v)
}

/** Pure: `{input, output, cacheWrite?, cacheRead?, webSearch?}` to prices; cache defaults follow Anthropic's 1.25x / 0.1x. */
export function parsePrices(raw: unknown): ModelPrices | undefined {
  if (!isRecord(raw)) return undefined
  const input = num(raw.input)
  const output = num(raw.output)
  if (input === undefined || output === undefined) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    promptCacheWriteTokens: num(raw.cacheWrite) ?? input * 1.25,
    promptCacheReadTokens: num(raw.cacheRead) ?? input * 0.1,
    webSearchRequests: num(raw.webSearch) ?? WEB_SEARCH_USD,
  }
}

function parseModel(id: string, raw: unknown): ClaudeModelData | undefined {
  if (!isRecord(raw)) return undefined
  return {
    id,
    tier: isTier(raw.tier) ? raw.tier : undefined,
    version: str(raw.version),
    apiId: str(raw.apiId),
    knowledgeCutoff: str(raw.knowledgeCutoff),
    supportsFastMode: raw.supportsFastMode === true,
    contextWindow: num(raw.contextWindow),
    pricing: parsePrices(raw.pricing),
    fastPricing: parsePrices(raw.fastPricing),
    longPromptTokens: num(raw.longPromptTokens),
    longPricing: parsePrices(raw.longPricing),
  }
}

/** Pure: fields of `user` that are present win over `base`, one level deep. */
function overlayModel(base: unknown, user: unknown): unknown {
  if (!isRecord(user)) return base
  const b = isRecord(base) ? base : {}
  const out: Record<string, unknown> = { ...b, ...user }
  for (const k of ['pricing', 'fastPricing', 'longPricing']) {
    if (isRecord(b[k]) && isRecord(user[k])) out[k] = { ...b[k], ...user[k] }
  }
  return out
}

/**
 * Pure: layers a parsed user file over the parsed defaults. Throws when the
 * top level is not an object (the caller keeps the previous config); bad
 * entries inside are skipped so one typo does not drop the rest.
 */
export function mergeClaudeModels(defaults: ClaudeModelsConfig, user: unknown): ClaudeModelsConfig {
  if (!isRecord(user)) throw new Error('el JSON debe ser un objeto')
  const aliases = { ...defaults.aliases }
  if (isRecord(user.aliases)) {
    for (const t of TIERS) {
      const v = str(user.aliases[t])
      if (v) aliases[t] = v
    }
  }
  const picker = Array.isArray(user.picker)
    ? user.picker.flatMap((p): PickerEntry[] =>
        isRecord(p) && isTier(p.alias) ? [{ alias: p.alias, description: str(p.description) ?? '' }] : [],
      )
    : defaults.picker
  const models = { ...defaults.models }
  if (isRecord(user.models)) {
    for (const [id, raw] of Object.entries(user.models)) {
      const base = defaults.models[id] ? rawOf(defaults.models[id]!) : undefined
      const m = parseModel(id, overlayModel(base, raw))
      if (m) models[id] = m
    }
  }
  return { aliases, picker, models }
}

/** Pure: model data back to the JSON shape `parseModel` reads (so overlays compose). */
function rawOf(m: ClaudeModelData): Record<string, unknown> {
  const prices = (p?: ModelPrices) =>
    p && {
      input: p.inputTokens,
      output: p.outputTokens,
      cacheWrite: p.promptCacheWriteTokens,
      cacheRead: p.promptCacheReadTokens,
      webSearch: p.webSearchRequests,
    }
  return {
    tier: m.tier,
    version: m.version,
    apiId: m.apiId,
    knowledgeCutoff: m.knowledgeCutoff,
    supportsFastMode: m.supportsFastMode,
    contextWindow: m.contextWindow,
    pricing: prices(m.pricing),
    fastPricing: prices(m.fastPricing),
  }
}

function parseDefaults(): ClaudeModelsConfig {
  const j = defaultsJson as unknown as Record<string, unknown>
  const models: Record<string, ClaudeModelData> = {}
  for (const [id, raw] of Object.entries((j.models ?? {}) as Record<string, unknown>)) {
    const m = parseModel(id, raw)
    if (m) models[id] = m
  }
  return {
    aliases: j.aliases as ClaudeModelsConfig['aliases'],
    picker: j.picker as PickerEntry[],
    models,
  }
}

const store = createHotJson<ClaudeModelsConfig>({
  file: 'claude-models.json',
  defaults: parseDefaults(),
  merge: mergeClaudeModels,
  // Lazy import: this module must stay free of harness dependencies.
  onError: msg => void import('../../utils/debug.js').then(m => m.logForDebugging(msg, { level: 'warn' })),
})

/** Current config (hot-reloaded). */
export function getClaudeModels(): ClaudeModelsConfig {
  return store.get()
}

/** Tests only: drop the cache so the next read hits the file again. */
export function resetClaudeModelsForTesting(): void {
  store.reset()
}

/** Data of a model by canonical id, or undefined when it is not listed. */
export function claudeModelData(canonicalId: string): ClaudeModelData | undefined {
  return getClaudeModels().models[canonicalId]
}

/** Id sent to the API for a listed model (`apiId`, else its own id). */
export function claudeApiId(m: ClaudeModelData): string {
  return m.apiId ?? m.id
}

/** Model the family alias points at, e.g. `opus` to `claude-opus-5-5`; undefined when unset. */
export function claudeAliasModel(tier: ClaudeTier): ClaudeModelData | undefined {
  const cfg = getClaudeModels()
  const id = cfg.aliases[tier]
  return id ? cfg.models[id] ?? { id } : undefined
}

/** Display name of what the alias points at (`Opus 5.5`); just the tier name when no version is known. */
export function claudeAliasName(tier: ClaudeTier): string {
  const name = tier.charAt(0).toUpperCase() + tier.slice(1)
  const version = claudeAliasModel(tier)?.version
  return version ? `${name} ${version}` : name
}

/** API id the alias resolves to on the first-party API. */
export function claudeAliasApiId(tier: ClaudeTier): string | undefined {
  const m = claudeAliasModel(tier)
  return m ? claudeApiId(m) : undefined
}

/** Listed models that carry an identity (tier, version and apiId). */
export function claudeIdentityModels(): ClaudeModelData[] {
  return Object.values(getClaudeModels().models).filter(m => m.tier && m.version && m.apiId)
}

/**
 * Prices of a listed model; `fast` picks the fast-mode ones when it has them and
 * `promptTokens` the long-prompt ones when the prompt exceeds the model's threshold.
 */
export function claudePrices(
  canonicalId: string,
  fast = false,
  promptTokens = 0,
): ModelPrices | undefined {
  const m = claudeModelData(canonicalId)
  if (!m) return undefined
  if (fast && m.fastPricing) return m.fastPricing
  if (m.longPricing && m.longPromptTokens !== undefined && promptTokens > m.longPromptTokens) {
    return m.longPricing
  }
  return m.pricing
}
