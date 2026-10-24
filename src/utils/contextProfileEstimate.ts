/**
 * Rough token cost of what a context profile sends with every request:
 * system prompt + tool definitions + the skill listing. Counted locally
 * (chars / 4, like roughTokenCountEstimation) so it costs no API call and
 * works the same for local backends; results are cached per profile + pool.
 */

import { getProjectRoot, getSystemPromptSectionCache } from '../bootstrap/state.js'
import { getSkillToolCommands } from '../commands.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools } from '../Tool.js'
import { assembleToolPool } from '../tools.js'
import { formatCommandsWithinBudget } from '../tools/SkillTool/prompt.js'
import { isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import { isToolSearchEnabled } from './toolSearch.js'
import { toolToAPISchema } from './api.js'
import {
  filterMcpClientsByProfile,
  filterSkillsByProfile,
  filterToolsByProfile,
  formatProfile,
  scopeLookup,
  type ContextProfile,
} from './contextProfile.js'
import { getMainLoopModel } from './model/model.js'

export type ContextEstimate = {
  total: number
  system: number
  tools: number
  skills: number
  toolCount: number
}

const cache = new Map<string, Promise<ContextEstimate>>()

export function toolsForProfile(state: AppState, profile: ContextProfile | undefined): Tools {
  const pool = assembleToolPool(state.toolPermissionContext, state.mcp.tools)
  return filterToolsByProfile(pool, profile, scopeLookup(state.mcp.clients))
}

async function compute(state: AppState, profile: ContextProfile): Promise<ContextEstimate> {
  const tools = toolsForProfile(state, profile)
  const model = state.mainLoopModel ?? getMainLoopModel()
  const getToolPermissionContext = async () => state.toolPermissionContext
  const agents = state.agentDefinitions?.activeAgents ?? []
  // Deferred tools (behind ToolSearch) are not sent up front; leave them out
  // like claude.ts does.
  const deferred =
    tools.some(t => t.name === TOOL_SEARCH_TOOL_NAME) &&
    (await isToolSearchEnabled(model, tools, getToolPermissionContext, agents))
  const sent = deferred ? tools.filter(t => !isDeferredTool(t)) : tools.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME)
  const schemas = await Promise.all(
    sent.map(t =>
      toolToAPISchema(t, {
        getToolPermissionContext,
        tools,
        agents,
        model,
      }),
    ),
  )
  // getSystemPrompt memoizes its sections for the live conversation; keep
  // that cache exactly as it was so estimating another profile never leaks
  // into the next real request.
  const sectionCache = getSystemPromptSectionCache()
  const saved = new Map(sectionCache)
  sectionCache.clear()
  let system: string[]
  try {
    system = await getSystemPrompt(tools, model, [], filterMcpClientsByProfile(state.mcp.clients, profile))
  } finally {
    sectionCache.clear()
    for (const [k, v] of saved) sectionCache.set(k, v)
  }
  let skills = 0
  if (tools.some(t => t.name === 'Skill')) {
    const cmds = filterSkillsByProfile(await getSkillToolCommands(getProjectRoot()), profile)
    skills = roughTokenCountEstimation(formatCommandsWithinBudget(cmds))
  }
  const systemTokens = roughTokenCountEstimation(system.join('\n'))
  const toolTokens = roughTokenCountEstimation(JSON.stringify(schemas))
  return {
    total: systemTokens + toolTokens + skills,
    system: systemTokens,
    tools: toolTokens,
    skills,
    toolCount: sent.length,
  }
}

/** Cached estimate for `profile` given the current MCP pool and model. */
export function estimateContextProfile(state: AppState, profile: ContextProfile): Promise<ContextEstimate> {
  const key = [
    formatProfile(profile),
    state.mainLoopModel ?? '',
    state.toolPermissionContext.mode,
    state.mcp.tools.map(t => t.name).join(','),
  ].join('|')
  let hit = cache.get(key)
  if (!hit) {
    hit = compute(state, profile).catch(() => ({ total: 0, system: 0, tools: 0, skills: 0, toolCount: 0 }))
    cache.set(key, hit)
  }
  return hit
}
