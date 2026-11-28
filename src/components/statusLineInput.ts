/**
 * The JSON input of the status line command, for the session or for the
 * agent whose transcript is being viewed.
 *
 * When the user enters a subagent's view (viewingAgentTaskId), every field
 * describes THAT agent: its model, its account (id, label, provider, base
 * URL, holder), its context (usage of its messages against its model's real
 * window), its cost and token totals, its account's 5h/7d windows and its
 * backend server. Nothing of the session leaks in: a subagent on zcode viewed
 * from a Claude session shows no Claude model, no Claude limits and no session
 * cost. Leaving the view goes back to the session.
 *
 * The routed agent is built inside its account scope (withModelRoute), so
 * getMultimodelProfile(), getContextWindowForModel() and getOauthAccountInfo()
 * answer for the agent's account without touching process.env.
 */

import { getIsRemoteMode, getMainThreadAgentType, getOriginalCwd, getSdkBetas, getSessionId } from '../bootstrap/state.js'
import { DEFAULT_OUTPUT_STYLE_NAME } from '../constants/outputStyles.js'
import { getTotalAPIDuration, getTotalCost, getTotalDuration, getTotalInputTokens, getTotalLinesAdded, getTotalLinesRemoved, getTotalOutputTokens } from '../cost-tracker.js'
import { getMocks } from '../dev/mocks.js'
import type { ReadonlySettings } from '../hooks/useSettings.js'
import { currentAccountId, sessionAccountId, tryRouteForModel, withModelRoute } from '../services/api/accountRouting.js'
import { findProvider } from '../services/api/openai-compat/catalog.js'
import { loadCatalog } from '../services/api/openai-compat/catalogStore.js'
import { getModelLimits, getMultimodelProfile } from '../services/api/openai-compat/profiles.js'
import { getLastSpeedSummary } from '../services/api/openai-compat/speedStats.js'
import { buildAccountStatus, contextSource, getServerInfo, refreshServerInfo } from '../services/api/openai-compat/statusInfo.js'
import { getRawUtilization } from '../services/claudeAiLimits.js'
import { getAutoCompactThreshold, isAutoCompactEnabled } from '../services/compact/autoCompact.js'
import type { Message } from '../types/message.js'
import type { VimMode } from '../types/textInputTypes.js'
import { getOauthAccountInfo } from '../utils/auth.js'
import { calculateContextPercentages, getContextWindowForModel, getModelMaxOutputTokens } from '../utils/context.js'
import { getCwd } from '../utils/cwd.js'
import { createBaseHookInput } from '../utils/hooks.js'
import { calculateUSDCost } from '../utils/modelCost.js'
import { getRuntimeMainLoopModel, renderModelName } from '../utils/model/model.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import { getCurrentUsage, getTokenUsage } from '../utils/tokens.js'
import { voiceListenStatus, voiceStatusJson } from '../utils/voiceListenRuntime.js'
import { getCurrentWorktreeSession } from '../utils/worktree.js'
import { isVimModeEnabled } from './PromptInput/utils.js'

/** The agent whose transcript is on screen, in the fields the status line needs. */
export type ViewedAgent = {
  id: string
  /** agentType, or the teammate's name. */
  name: string
  description?: string
  /** Resolved model; `cuenta:modelo` when the agent runs on another account. Undefined = inherits the session's. */
  model?: string
  messages: Message[]
  startTime: number
  endTime?: number
}

export type StatusLineCost = {
  total_cost_usd: number
  total_duration_ms: number
  total_api_duration_ms: number
  total_lines_added: number
  total_lines_removed: number
}

/** What the status line describes: the session, or the viewed agent. */
export type StatusLineView =
  | { scope: 'session'; mainLoopModel: string; messages: Message[] }
  | { scope: 'agent'; mainLoopModel: string; messages: Message[]; agent: ViewedAgent }

/**
 * Pure: the conversation the status line must describe. A viewed agent wins
 * over the session; an agent without its own model runs on the session's.
 */
export function selectStatusLineView(
  session: { mainLoopModel: string; messages: Message[] },
  viewed: ViewedAgent | undefined,
): StatusLineView {
  if (!viewed) return { scope: 'session', ...session }
  return {
    scope: 'agent',
    mainLoopModel: viewed.model || session.mainLoopModel,
    messages: viewed.messages,
    agent: viewed,
  }
}

/**
 * Pure: a task from AppState (local agent or in-process teammate) as a
 * ViewedAgent, or undefined for anything else.
 */
export function viewedAgentFromTask(task: unknown): ViewedAgent | undefined {
  const t = task as Record<string, any> | undefined
  if (!t) return undefined
  if (t.type === 'local_agent') {
    return {
      id: String(t.agentId ?? t.id),
      name: String(t.agentType ?? 'agent'),
      description: t.description,
      model: t.model,
      messages: t.messages ?? [],
      startTime: t.startTime,
      endTime: t.endTime,
    }
  }
  if (t.type === 'in_process_teammate') {
    return {
      id: String(t.identity?.agentId ?? t.id),
      name: String(t.identity?.agentName ?? 'teammate'),
      description: t.description,
      model: t.model,
      messages: t.messages ?? [],
      startTime: t.startTime,
      endTime: t.endTime,
    }
  }
  return undefined
}

/**
 * Cost and token totals of an agent, from its own assistant messages. Split
 * records of one API response (parallel tool calls) share message.id and
 * are counted once.
 */
export function agentTotalsFromMessages(
  model: string,
  agent: Pick<ViewedAgent, 'messages' | 'startTime' | 'endTime'>,
  now: number,
  price: (model: string, usage: NonNullable<ReturnType<typeof getTokenUsage>>) => number = calculateUSDCost,
): { cost: StatusLineCost; inputTokens: number; outputTokens: number } {
  const seen = new Set<string>()
  let usd = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const m of agent.messages) {
    const usage = getTokenUsage(m)
    if (!usage) continue
    const id = (m as { message?: { id?: string } }).message?.id
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    inputTokens += usage.input_tokens ?? 0
    outputTokens += usage.output_tokens ?? 0
    try {
      usd += price(model, usage)
    } catch {
      // An unpriced model costs what we can tell: nothing.
    }
  }
  const start = Number.isFinite(agent.startTime) ? agent.startTime : now
  return {
    cost: {
      total_cost_usd: usd,
      total_duration_ms: Math.max(0, (agent.endTime ?? now) - start),
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    inputTokens,
    outputTokens,
  }
}

/** Session-wide sources, injectable so tests can tell them apart from the agent's. */
export type SessionSources = {
  cost: () => StatusLineCost
  inputTokens: () => number
  outputTokens: () => number
}

export const defaultSessionSources: SessionSources = {
  cost: () => ({
    total_cost_usd: getTotalCost(),
    total_duration_ms: getTotalDuration(),
    total_api_duration_ms: getTotalAPIDuration(),
    total_lines_added: getTotalLinesAdded(),
    total_lines_removed: getTotalLinesRemoved(),
  }),
  inputTokens: getTotalInputTokens,
  outputTokens: getTotalOutputTokens,
}

/** The `fnharness` block: account, real window, server and speed, for the account in force. */
function buildFnharnessStatus(
  runtimeModel: string,
  contextWindowSize: number,
  perfil: { name: string; modified: boolean } | undefined,
  isAgent: boolean,
) {
  const profile = getMultimodelProfile()
  refreshServerInfo(profile?.baseUrl)
  const server = getServerInfo(profile?.baseUrl)
  const limits = profile ? getModelLimits(profile, runtimeModel) : {}
  const priced = profile?.catalogProvider ? findProvider(loadCatalog(), profile.catalogProvider)?.models.find(m => m.id === runtimeModel) : undefined
  let maxOutput: number | null = null
  try {
    maxOutput = getModelMaxOutputTokens(runtimeModel).default
  } catch {}
  let autoCompactAt: number | null = null
  try {
    autoCompactAt = isAutoCompactEnabled() ? getAutoCompactThreshold(runtimeModel) : null
  } catch {}
  // Titular de la cuenta: solo una cuenta Anthropic (OAuth) lo expone; las OpenAI-compatibles no.
  const holder = profile ? undefined : getOauthAccountInfo()
  const account = buildAccountStatus({
    email: holder?.emailAddress ?? null,
    org: holder?.organizationName ?? null,
    accountId: currentAccountId(),
    accountLabel: profile?.label ?? 'Claude',
    provider: profile?.provider ?? null,
    baseUrl: profile?.baseUrl ?? null,
    model: runtimeModel,
    contextWindow: contextWindowSize,
    contextSource: contextSource({
      native: !profile,
      serverNCtx: server?.nCtx ?? null,
      presetWindow: profile?.contextWindow,
      catalogWindow: limits.contextWindow,
    }),
    autoCompactAt,
    maxOutputTokens: maxOutput,
    server,
    // The last measured speed and the /perfil scope belong to the session.
    speed: isAgent ? null : getLastSpeedSummary(),
    profile: isAgent ? null : (perfil ?? null),
    pricePerMtok: priced?.costInput !== undefined && priced.costOutput !== undefined ? { input: priced.costInput, output: priced.costOutput } : null,
    now: Date.now(),
  })
  // Estado del micrófono (/escucha): listening, speaking y last (mic + hora); nunca el texto oído.
  return {
    ...account,
    voice: voiceStatusJson(voiceListenStatus()),
  }
}

export type StatusLineInputArgs = {
  view: StatusLineView
  permissionMode: PermissionMode
  exceeds200kTokens: boolean
  settings: ReadonlySettings
  addedDirs: string[]
  vimMode?: VimMode
  perfil?: { name: string; modified: boolean }
  session?: SessionSources
  now?: number
}

/**
 * The status line input for `view`. A view whose model is `cuenta:modelo` on
 * another account is built inside that account's scope.
 */
export function buildStatusLineCommandInput(args: StatusLineInputArgs) {
  const route = tryRouteForModel(args.view.mainLoopModel)
  return withModelRoute(args.view.mainLoopModel, model => buildFor(args, model, route?.accountId), route)
}

function buildFor(args: StatusLineInputArgs, mainLoopModel: string, routedAccount: string | undefined) {
  const { view, permissionMode, exceeds200kTokens, settings, addedDirs, vimMode, perfil } = args
  const session = args.session ?? defaultSessionSources
  const isAgent = view.scope === 'agent'
  const agent = view.scope === 'agent' ? view.agent : undefined
  const agentType = agent ? agent.name : getMainThreadAgentType()
  const worktreeSession = getCurrentWorktreeSession()
  const runtimeModel = getRuntimeMainLoopModel({ permissionMode, mainLoopModel, exceeds200kTokens })
  const outputStyleName = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const currentUsage = getCurrentUsage(view.messages)
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas())
  const contextPercentages = calculateContextPercentages(currentUsage, contextWindowSize)
  const sessionId = getSessionId()
  const sessionName = getCurrentSessionTitle(sessionId)
  // Limits of the account that serves this view: the session's, or the agent's own.
  const limitsAccount = routedAccount ?? sessionAccountId()
  const rawUtil = getRawUtilization(limitsAccount)
  const rateLimits = {
    ...(rawUtil.five_hour && {
      five_hour: { used_percentage: rawUtil.five_hour.utilization * 100, resets_at: rawUtil.five_hour.resets_at },
    }),
    ...(rawUtil.seven_day && {
      seven_day: { used_percentage: rawUtil.seven_day.utilization * 100, resets_at: rawUtil.seven_day.resets_at },
    }),
  }
  const totals = agent
    ? agentTotalsFromMessages(view.mainLoopModel, agent, args.now ?? Date.now())
    : { cost: session.cost(), inputTokens: session.inputTokens(), outputTokens: session.outputTokens() }
  const mockPct = isAgent ? null : getMocks().contextPct
  return {
    ...createBaseHookInput(undefined, undefined, agent ? { agentId: agent.id, agentType: agent.name } : undefined),
    ...(sessionName && { session_name: sessionName }),
    model: { id: runtimeModel, display_name: renderModelName(runtimeModel) },
    workspace: { current_dir: getCwd(), project_dir: getOriginalCwd(), added_dirs: addedDirs },
    version: MACRO.VERSION,
    output_style: { name: outputStyleName },
    cost: totals.cost,
    context_window: {
      total_input_tokens: totals.inputTokens,
      total_output_tokens: totals.outputTokens,
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: mockPct ?? contextPercentages.used,
      remaining_percentage: mockPct != null ? 100 - mockPct : contextPercentages.remaining,
    },
    exceeds_200k_tokens: exceeds200kTokens,
    fnharness: buildFnharnessStatus(runtimeModel, contextWindowSize, perfil, isAgent),
    ...((rateLimits.five_hour || rateLimits.seven_day) && { rate_limits: rateLimits }),
    ...(isVimModeEnabled() && { vim: { mode: vimMode ?? 'INSERT' } }),
    ...(agentType && {
      agent: {
        name: agentType,
        ...(agent && { id: agent.id, viewed: true, ...(agent.description && { description: agent.description }) }),
      },
    }),
    ...(getIsRemoteMode() && { remote: { session_id: getSessionId() } }),
    ...(worktreeSession && {
      worktree: {
        name: worktreeSession.worktreeName,
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch,
        original_cwd: worktreeSession.originalCwd,
        original_branch: worktreeSession.originalBranch,
      },
    }),
  }
}
