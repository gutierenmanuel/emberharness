import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import { tryRouteForModel, withModelRoute } from '../services/api/accountRouting.js'
import { findProvider, type Catalog } from '../services/api/openai-compat/catalog.js'
import { loadCatalog } from '../services/api/openai-compat/catalogStore.js'
import { getMultimodelProfile } from '../services/api/openai-compat/profiles.js'
import { claudeAliasModel, claudePrices } from '../services/config/claudeModels.js'
import { providerModelOverride } from '../services/config/providers.js'
import {
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

const ZERO_COST: ModelCosts = {
  inputTokens: 0,
  outputTokens: 0,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
}

/**
 * Prices of the model the `opus` alias points at: what a model nobody has
 * priced is billed as. The prices themselves live in claude-models.json.
 */
function unknownModelCost(): ModelCosts {
  const opus = claudeAliasModel('opus')
  return (opus && claudePrices(opus.id)) || ZERO_COST
}

/**
 * Prices of the Opus that offers fast mode (`fastMode` and the feature on pick
 * the fast-mode prices). Data in claude-models.json.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  return (
    claudePrices('claude-opus-4-6', isFastModeEnabled() && fastMode) ??
    unknownModelCost()
  )
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(model)

  // Fast mode has its own prices on the models that offer it.
  // A prompt counts every input token, cache reads and writes included.
  const promptTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const costs = claudePrices(
    shortName,
    usage.speed === 'fast' && isFastModeEnabled(),
    promptTokens,
  )
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      claudePrices(getCanonicalName(getDefaultMainLoopModelSetting())) ??
      unknownModelCost()
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  // `cuenta:modelo` (a subagent on another account): price it on that account.
  const route = tryRouteForModel(resolvedModel)
  if (route) {
    return withModelRoute(resolvedModel, m => calculateUSDCost(m, usage), route)
  }
  const multimodel = getMultimodelProfile()
  if (multimodel) {
    // A price set in providers.json beats the models.dev catalog.
    return tokensToUSDCost(
      providerModelOverride(multimodel.provider, resolvedModel)?.pricing ??
        multimodelModelCosts(loadCatalog(), multimodel.catalogProvider, resolvedModel),
      usage,
    )
  }
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Pure: prices of a model on an OpenAI-compatible account, from the models.dev
 * catalog (USD per Mtok). Local servers and models the catalog does not price
 * cost 0 rather than being billed as a Claude model. Cached tokens are priced
 * like input: the catalog has no separate cache price for most providers.
 */
export function multimodelModelCosts(
  catalog: Catalog,
  catalogProvider: string | undefined,
  model: string,
): ModelCosts {
  if (!catalogProvider) return ZERO_COST
  const m = findProvider(catalog, catalogProvider)?.models.find(x => x.id === model)
  if (!m || m.costInput === undefined || m.costOutput === undefined) return ZERO_COST
  return {
    inputTokens: m.costInput,
    outputTokens: m.costOutput,
    promptCacheWriteTokens: m.costInput,
    promptCacheReadTokens: m.costInput,
    webSearchRequests: 0,
  }
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = claudePrices(shortName)
  if (!costs) return undefined
  return formatModelPricing(costs)
}
