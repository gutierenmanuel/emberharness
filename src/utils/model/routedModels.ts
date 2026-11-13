/**
 * Models of every connected account, for the unified /model picker and for
 * the Agent tool (which accepts `cuenta:modelo`). The pure builders come
 * first and are unit-tested; gatherAccountModelGroups does the I/O.
 */

import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  isAnthropicAccount,
  listAccounts,
  loadStore,
} from '../../services/api/openai-compat/accounts.js'
import {
  describeModel,
  listAccountModels,
  modelStats,
  targetForAccount,
} from '../../services/api/openai-compat/accountModels.js'
import { connectedAccountIds } from '../../services/api/openai-compat/connected.js'
import { routeForModel, sessionAccountId } from '../../services/api/accountRouting.js'
import { displayModelId } from './multimodelOptions.js'
import { getMainLoopModel } from './model.js'
import {
  claudeAliasModel,
  claudeAliasName,
  claudeIdentityModels,
  claudePrices,
  getClaudeModels,
} from '../../services/config/claudeModels.js'

type Env = Record<string, string | undefined>

/** `info` is the short stats shown next to the name in /model (context, price...). */
export type ModelEntry = { value: string; label: string; description: string; info?: string }

export type AccountModelGroup = {
  accountId: string
  label: string
  /** The session's account. */
  active: boolean
  models: ModelEntry[]
  /** Who a Claude account is (its email), shown in the header. */
  identity?: string
}

export type PickerOption = {
  value: string
  label: string
  /** Short stats shown dimmed on the same line. */
  info?: string
  disabled?: boolean
}

/**
 * Claude models offered on the native account (aliases resolve per plan): one
 * entry per `picker` row of claude-models.json, so the names, windows and
 * prices follow the model each alias points at. Read on every call so edits to
 * the JSON show up without a restart.
 */
export function claudeModelEntries(): ModelEntry[] {
  const entries: ModelEntry[] = [
    { value: 'default', label: 'Default', description: 'El modelo recomendado para tu plan' },
  ]
  // Alias entries (latest of each tier) first
  const aliasIds = new Set<string>()
  for (const { alias, description } of getClaudeModels().picker) {
    const model = claudeAliasModel(alias)
    if (model) aliasIds.add(model.id)
    const ctx = (model?.contextWindow ?? 0) >= 1_000_000 ? '1M ctx' : '200k ctx'
    const prices = model && claudePrices(model.id)
    const price = prices ? ` · $${prices.inputTokens}/$${prices.outputTokens} por M` : ''
    entries.push({
      value: alias,
      label: `${claudeAliasName(alias)} (latest)`,
      description: `${ctx} · razonamiento · imagen — ${description}${price}`,
      info: `${ctx}${price}`,
    })
  }
  // All individual models with identity, grouped by tier
  const allModels = claudeIdentityModels().filter(m => !aliasIds.has(m.id))
  for (const m of allModels) {
    const ctx = (m.contextWindow ?? 0) >= 1_000_000 ? '1M ctx' : '200k ctx'
    const prices = claudePrices(m.id)
    const price = prices ? ` · $${prices.inputTokens}/$${prices.outputTokens} por M` : ''
    const label = claudeModelLabel(m.tier, m.version, m.id)
    entries.push({
      value: m.id,
      label,
      description: `${ctx}${price}${m.knowledgeCutoff ? ` · cutoff ${m.knowledgeCutoff}` : ''}`,
      info: `${ctx}${price}`,
    })
  }
  return entries
}

/**
 * Pure: the full Claude list first, then any plan-specific stock entry the
 * list lacks (for example a 1M variant). A stock entry with the same value
 * wins over the generic one, since it knows the plan's description (it keeps
 * the generic stats when it has none of its own).
 */
export function mergeClaudeEntries(full: ModelEntry[], stock: ModelEntry[] | undefined): ModelEntry[] {
  if (!stock?.length) return full
  const byValue = new Map(stock.map(m => [m.value, m]))
  const merged = full.map(m => {
    const s = byValue.get(m.value)
    return s ? { ...s, info: s.info ?? m.info } : m
  })
  const known = new Set(full.map(m => m.value))
  return [...merged, ...stock.filter(m => !known.has(m.value))]
}

/** Pure: "Opus 5.5" for a plain version, "Fable 5.1" when the version carries its own name ("5.1 Fable"). */
export function claudeModelLabel(tier: string | undefined, version: string | undefined, id: string): string {
  if (!version) return id
  const named = /^(\d+(?:\.\d+)*)\s+(\S.*)$/.exec(version)
  if (named) return `${named[2]} ${named[1]}`
  const t = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : ''
  return `${t} ${version}`.trim()
}

// ── pure ────────────────────────────────────────────────────────────────

/** Pure: `cuenta:modelo` picker value to its parts (account ids never hold a colon). */
export function decodePickerValue(value: string): { account: string; model: string } | null {
  const i = value.indexOf(':')
  if (i <= 0 || value.startsWith('h:')) return null
  return { account: value.slice(0, i), model: value.slice(i + 1) }
}

function matches(query: string, ...fields: string[]): boolean {
  const hay = fields.join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(term => hay.includes(term))
}

/**
 * Pure: flat Select options, one disabled header per account followed by its
 * models. `query` keeps the models whose `cuenta:modelo`, name or description
 * match every word; an account whose id or label matches keeps all of them.
 * The model in use is marked with ●. One line per model: the name, padded to
 * a column per account, then its short stats; the prose description is not
 * shown (the filter still searches it).
 */
export function buildModelPickerOptions(
  groups: AccountModelGroup[],
  query: string,
  current: { account: string; model: string | null },
): PickerOption[] {
  const q = query.trim()
  const out: PickerOption[] = []
  for (const g of groups) {
    const whole = q !== '' && matches(q, g.accountId, g.label)
    const models = g.models.filter(
      m => !q || whole || matches(q, `${g.accountId}:${m.value}`, m.label, m.description),
    )
    if (models.length === 0) continue
    out.push({
      value: `h:${g.accountId}`,
      label: `── ${g.label} (${g.accountId})${g.identity ? ` · ${g.identity}` : ''}${g.active ? ' · cuenta activa' : ''} ──`,
      disabled: true,
    })
    // Capped so one very long name does not push every row's stats off screen.
    const width = Math.min(44, Math.max(...models.map(m => m.label.length)))
    for (const m of models) {
      const inUse =
        g.accountId === current.account &&
        (m.value === (current.model ?? 'default') || m.value === current.model)
      out.push({
        value: `${g.accountId}:${m.value}`,
        label: `${inUse ? '●' : ' '} ${m.info ? m.label.padEnd(width) : m.label}`,
        ...(m.info ? { info: m.info } : {}),
      })
    }
  }
  if (out.length === 0) {
    out.push({ value: 'h:none', label: `  (nada coincide con "${q}")`, disabled: true })
  }
  return out
}

/**
 * Pure: the Agent tool paragraph explaining that `model` is a required
 * `cuenta:modelo`, with the session's own value and, per connected account,
 * at most `maxModels` models (the rest summarised).
 */
export function formatAgentAccountsSection(
  groups: AccountModelGroup[],
  maxModels = 6,
  sessionModel?: string,
): string {
  const lines = groups
    .filter(g => g.models.length > 0)
    .map(g => {
      const ids = g.models.filter(m => m.value !== 'default').map(m => m.value)
      const shown = ids.slice(0, maxModels).join(', ')
      const more = ids.length > maxModels ? ` (+${ids.length - maxModels} más)` : ''
      return `- ${g.accountId}${g.active ? ' (cuenta de la sesión)' : ''}: ${shown}${more}`
    })
  return [
    '',
    '## Account and model of every agent (required)',
    '`model` is REQUIRED on every Agent call and must be `cuenta:modelo`: the connected account that serves the agent and the model on it (for example `claude:haiku` or `qwen36:qwen36-35b-heretic-q4km`). A bare alias (`sonnet`) or a bare model id is rejected. The agent runs on that account while this session stays where it is, so you can hand work to a model of another account and keep managing it (SendMessage to continue it, TaskStop to stop it).',
    ...(sessionModel ? [`To keep the agent on this session's account and model, pass \`${sessionModel}\`.`] : []),
    'Connected accounts and some of their models:',
    ...lines,
  ].join('\n')
}

/** Pure: what to show when `model` is not a usable `cuenta:modelo`. */
function agentModelFormatHint(sessionModel?: string): string {
  const own = sessionModel ? ` (this session: ${sessionModel})` : ''
  return `the Agent tool needs \`model\` as cuenta:modelo, an account from /account and a model on it, e.g. claude:haiku or qwen36:qwen36-35b-heretic-q4km${own}`
}

/**
 * Pure: why `model` cannot be used for a subagent, or null when it can.
 * `model` is required and must be `cuenta:modelo` with both parts. `route`
 * resolves it (null when the prefix is no account; throws when the account
 * cannot serve).
 */
export function agentModelParamError(
  model: string | undefined,
  route: (m: string) => unknown,
  sessionModel?: string,
): string | null {
  const hint = agentModelFormatHint(sessionModel)
  if (!model || !model.trim()) return `model is missing: ${hint}`
  const i = model.indexOf(':')
  if (i <= 0) return `model "${model}" has no account: ${hint}`
  if (!model.slice(i + 1).trim()) return `model "${model}" names no model after the account: ${hint}`
  try {
    if (route(model)) return null
  } catch (err) {
    return `model "${model}": ${err instanceof Error ? err.message : String(err)}`
  }
  return `model "${model}": "${model.slice(0, i)}" is not a connected account: ${hint}`
}

// ── I/O ─────────────────────────────────────────────────────────────────

export type GatherOptions = {
  env?: Env
  /** Query hosted /models too (default true; the Agent tool prompt passes false). */
  remote?: boolean
  /** The session's model, listed first on its account. */
  sessionModel?: string | null
  /** Stock Claude options when the session is on Claude (keeps plan-specific entries). */
  claudeOptions?: ModelEntry[]
  /** Email of each Claude account (header identity in /model). */
  identities?: Record<string, string | undefined>
}

/** Connected accounts with their models, the session's account first. Never throws. */
export async function gatherAccountModelGroups(opts: GatherOptions = {}): Promise<AccountModelGroup[]> {
  const env = opts.env ?? process.env
  const session = sessionAccountId(env)
  const store = loadStore(accountsFilePath(env))
  const labels = new Map(listAccounts(store, env).map(a => [a.id, a.label]))
  let ids: string[]
  try {
    ids = await connectedAccountIds(env, { store })
  } catch {
    ids = [CLAUDE_ACCOUNT_ID]
  }
  if (!ids.includes(session)) ids.unshift(session)
  const remote = opts.remote !== false && env.FNHARNESS_DISABLE_MODELS_FETCH !== '1'

  const groups = await Promise.all(
    ids.map(async (id): Promise<AccountModelGroup> => {
      const active = id === session
      const label = labels.get(id) ?? id
      if (isAnthropicAccount(id, store)) {
        const identity = opts.identities?.[id]
        return {
          accountId: id,
          label,
          active,
          models: mergeClaudeEntries(claudeModelEntries(), active ? opts.claudeOptions : undefined),
          ...(identity ? { identity } : {}),
        }
      }
      try {
        const target = targetForAccount(id, store, env)
        if (!target) return { accountId: id, label, active, models: [] }
        const models: ModelEntry[] = (await listAccountModels(target, { remote })).map(m => {
          const shown = displayModelId(m.id)
          return {
            value: m.id,
            label: m.name && m.name !== m.id ? `${m.name} (${shown})` : shown,
            description: shown !== m.id ? `${describeModel(m)} · fichero ${m.id}` : describeModel(m),
            info: modelStats(m) || undefined,
          }
        })
        const own = active && opts.sessionModel ? opts.sessionModel : store.accounts[id]?.model
        if (own && !models.some(m => m.value === own)) {
          models.unshift({ value: own, label: own, description: active ? 'Modelo actual' : 'Modelo guardado de la cuenta' })
        } else if (own) {
          const i = models.findIndex(m => m.value === own)
          models.unshift(...models.splice(i, 1))
        }
        return { accountId: id, label, active, models }
      } catch {
        return { accountId: id, label, active, models: [] }
      }
    }),
  )
  return groups.sort((a, b) => Number(b.active) - Number(a.active))
}

/** The session's own `cuenta:modelo`, what an agent that stays on it must pass. */
export function sessionAgentModel(): string {
  return `${sessionAccountId()}:${getMainLoopModel()}`
}

/** Agent tool paragraph for the current process. Never throws. */
export async function agentAccountsPromptSection(): Promise<string> {
  try {
    return formatAgentAccountsSection(await gatherAccountModelGroups({ remote: false }), 6, sessionAgentModel())
  } catch {
    return ''
  }
}

/** Validation of the Agent tool `model` parameter against the live accounts. */
export function validateAgentModelParam(model: string | undefined): string | null {
  return agentModelParamError(model, m => routeForModel(m), sessionAgentModel())
}
