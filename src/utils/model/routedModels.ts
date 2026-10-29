/**
 * Models of every connected account, for the unified /model picker and for
 * the Agent tool (which accepts `cuenta:modelo`). The pure builders come
 * first and are unit-tested; gatherAccountModelGroups does the I/O.
 */

import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  listAccounts,
  loadStore,
} from '../../services/api/openai-compat/accounts.js'
import {
  describeModel,
  listAccountModels,
  targetForAccount,
} from '../../services/api/openai-compat/accountModels.js'
import { connectedAccountIds } from '../../services/api/openai-compat/connected.js'
import { routeForModel, sessionAccountId } from '../../services/api/accountRouting.js'
import { displayModelId } from './multimodelOptions.js'

type Env = Record<string, string | undefined>

export type ModelEntry = { value: string; label: string; description: string }

export type AccountModelGroup = {
  accountId: string
  label: string
  /** The session's account. */
  active: boolean
  models: ModelEntry[]
}

export type PickerOption = {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

/** Claude models offered on the native account (aliases resolve per plan). */
export const CLAUDE_MODEL_ENTRIES: ModelEntry[] = [
  { value: 'default', label: 'Default', description: 'El modelo recomendado para tu plan' },
  { value: 'sonnet', label: 'Sonnet', description: '200k-1M ctx · razonamiento · imagen — equilibrado, el de diario' },
  { value: 'opus', label: 'Opus', description: '200k-1M ctx · razonamiento · imagen — el más capaz para razonamiento complejo' },
  { value: 'haiku', label: 'Haiku', description: '200k ctx · razonamiento · imagen — rápido y barato para tareas simples' },
]

export const AGENT_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'inherit'] as const

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
 * The model in use is marked with ●.
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
      label: `── ${g.label} (${g.accountId})${g.active ? ' · cuenta activa' : ''} ──`,
      disabled: true,
    })
    for (const m of models) {
      const inUse =
        g.accountId === current.account &&
        (m.value === (current.model ?? 'default') || m.value === current.model)
      out.push({
        value: `${g.accountId}:${m.value}`,
        label: `${inUse ? '●' : ' '} ${m.label}`,
        description: m.description,
      })
    }
  }
  if (out.length === 0) {
    out.push({ value: 'h:none', label: `  (nada coincide con "${q}")`, disabled: true })
  }
  return out
}

/**
 * Pure: the Agent tool paragraph listing what `model` accepts, short: at most
 * `maxModels` per account, the rest summarised.
 */
export function formatAgentAccountsSection(
  groups: AccountModelGroup[],
  maxModels = 6,
): string {
  const others = groups.filter(g => g.models.length > 0)
  if (others.length <= 1 && others.every(g => g.active)) return ''
  const lines = others.map(g => {
    const ids = g.models.filter(m => m.value !== 'default').map(m => m.value)
    const shown = ids.slice(0, maxModels).join(', ')
    const more = ids.length > maxModels ? ` (+${ids.length - maxModels} más)` : ''
    return `- ${g.accountId}${g.active ? ' (cuenta de la sesión)' : ''}: ${shown}${more}`
  })
  return [
    '',
    '## Running an agent on another account',
    '`model` also accepts `cuenta:modelo` to run that agent on another connected account while this session stays where it is (for example `claude:haiku` or `qwen36:qwen36-35b-heretic-q4km`). Connected accounts and some of their models:',
    ...lines,
  ].join('\n')
}

/**
 * Pure: why `model` cannot be used for a subagent, or null when it can.
 * `route` resolves a `cuenta:modelo` (throws when the account cannot serve).
 */
export function agentModelParamError(
  model: string | undefined,
  route: (m: string) => unknown,
): string | null {
  if (!model) return null
  if ((AGENT_MODEL_ALIASES as readonly string[]).includes(model.toLowerCase())) return null
  try {
    if (route(model)) return null
  } catch (err) {
    return `model "${model}": ${err instanceof Error ? err.message : String(err)}`
  }
  return `model "${model}" is not valid: use sonnet, opus, haiku, inherit or cuenta:modelo (an account from /account, e.g. claude:haiku or qwen36:qwen36-35b-heretic-q4km)`
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
      if (id === CLAUDE_ACCOUNT_ID) {
        return { accountId: id, label, active, models: active && opts.claudeOptions?.length ? opts.claudeOptions : CLAUDE_MODEL_ENTRIES }
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

/** Agent tool paragraph for the current process. Never throws. */
export async function agentAccountsPromptSection(): Promise<string> {
  try {
    return formatAgentAccountsSection(await gatherAccountModelGroups({ remote: false }))
  } catch {
    return ''
  }
}

/** Validation of the Agent tool `model` parameter against the live accounts. */
export function validateAgentModelParam(model: string | undefined): string | null {
  return agentModelParamError(model, m => routeForModel(m))
}
