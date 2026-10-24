// Session-scoped state and judge call behind `/goal`. The pure decisions live in
// goalLogic.ts; this file owns the singleton and talks to the model.

import { getTotalInputTokens, getTotalOutputTokens } from '../../bootstrap/state.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  loadStore,
  profileForAccount,
} from '../../services/api/openai-compat/accounts.js'
import {
  getMultimodelProfile,
  setActiveProfile,
} from '../../services/api/openai-compat/profiles.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { errorMessage } from '../errors.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { getInitialSettings } from '../settings/settings.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  JUDGE_SYSTEM_PROMPT,
  type GoalState,
  type GoalVerdict,
  type LooseMessage,
  buildContinuePrompt,
  buildJudgePrompt,
  decideAfterTurn,
  formatIndicator,
  formatOutcome,
  messagesSince,
  messagesToEntries,
  parseVerdict,
  renderTranscript,
  turnUsedTools,
} from './goalLogic.js'

/** Text of the kickoff meta message; marks where the goal's own work begins. */
export const GOAL_KICKOFF_MARKER = 'A goal is now active for this session:'

let current: GoalState | null = null

export function getGoal(): GoalState | null {
  return current
}

export function setGoal(state: GoalState | null): void {
  current = state
}

/** Judge account: explicit arg, then env, then the `goalJudge` setting. */
export function resolveJudgeAccount(explicit: string | null): string | null {
  if (explicit) return explicit
  const fromEnv = process.env.FNHARNESS_GOAL_JUDGE?.trim()
  if (fromEnv) return fromEnv
  try {
    return getInitialSettings().goalJudge?.trim() || null
  } catch {
    return null
  }
}

/** Messages that belong to the goal's own work (after the previous checkpoint). */
export function goalMessagesSince(messages: Message[], lastUuid: string | null): Message[] {
  if (lastUuid) return messagesSince(messages as Array<Message & { uuid?: string }>, lastUuid)
  const idx = messages.findLastIndex(m => {
    const c = (m as LooseMessage).message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b as { text?: string }).text ?? '').join('') : ''
    return text.includes(GOAL_KICKOFF_MARKER)
  })
  return idx === -1 ? messages : messages.slice(idx)
}

/** Runs `fn` with `account` as the live backend, then restores the previous one. */
async function withAccount<T>(account: string | null, fn: () => Promise<T>): Promise<T> {
  if (!account) return fn()
  const previousProfile = getMultimodelProfile()
  const previousId = process.env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
  if (account === previousId) return fn()
  const store = loadStore(accountsFilePath())
  const profile = profileForAccount(account, store, process.env)
  setActiveProfile(profile, account)
  try {
    return await fn()
  } finally {
    setActiveProfile(previousProfile, previousId)
  }
}

/** Asks the judge whether the goal holds, given the work done so far. */
export async function judgeGoal(
  state: GoalState,
  turnMessages: Message[],
  toolUseContext: ToolUseContext,
  signal: AbortSignal,
): Promise<GoalVerdict> {
  const transcript = renderTranscript(messagesToEntries(turnMessages as LooseMessage[]))
  const prompt = buildJudgePrompt(state.condition, transcript)
  const account = resolveJudgeAccount(state.judge)
  try {
    return await withAccount(account, async () => {
      const response = await queryModelWithoutStreaming({
        messages: [createUserMessage({ content: prompt })],
        systemPrompt: asSystemPrompt([JUDGE_SYSTEM_PROMPT]),
        thinkingConfig: { type: 'disabled' as const },
        tools: [],
        signal,
        options: {
          async getToolPermissionContext() {
            return toolUseContext.getAppState().toolPermissionContext
          },
          model: getSmallFastModel(),
          toolChoice: undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt',
          mcpTools: [],
          agentId: toolUseContext.agentId,
        },
      })
      return parseVerdict(extractTextContent(response.message.content))
    })
  } catch (err) {
    throw new Error(errorMessage(err))
  }
}

export type GoalCheckResult = {
  /** One-line status for the user (indicator or final outcome). */
  text: string
  /** Set when the agent must keep working: the meta message to append. */
  continueWith: Message | null
}

/**
 * Called from the Stop path after the agent ended a turn. Returns null when no
 * goal is active. Mutates the session goal (turn count, clearing it on exit).
 */
export async function runGoalCheck(
  allMessages: Message[],
  toolUseContext: ToolUseContext,
): Promise<GoalCheckResult | null> {
  const state = current
  if (!state) return null
  const now = Date.now()

  const sinceCheckpoint = goalMessagesSince(allMessages, state.lastUuid) as LooseMessage[]
  const sinceKickoff = goalMessagesSince(allMessages, null)
  const lastUuid = (allMessages[allMessages.length - 1] as { uuid?: string } | undefined)?.uuid ?? null

  let verdict: GoalVerdict
  try {
    verdict = await judgeGoal(state, sinceKickoff, toolUseContext, toolUseContext.abortController.signal)
  } catch (err) {
    current = null
    return { text: formatOutcome('judge_error', state, now, errorMessage(err)), continueWith: null }
  }

  const decision = decideAfterTurn(state, verdict, {
    usedTools: turnUsedTools(sinceCheckpoint),
    totalTokens: getTotalInputTokens() + getTotalOutputTokens(),
    lastUuid,
  })
  if (decision.action === 'continue') {
    current = decision.state
    return {
      text: formatIndicator(decision.state, now),
      continueWith: createUserMessage({
        content: buildContinuePrompt(state.condition, verdict.reason),
        isMeta: true,
      }),
    }
  }
  current = null
  return { text: formatOutcome(decision.action, decision.state, now), continueWith: null }
}
