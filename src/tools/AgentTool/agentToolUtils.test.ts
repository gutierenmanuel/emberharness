import { describe, expect, test } from 'bun:test'
import type { Tools } from '../../Tool.js'
// Loaded first so the Agent tool module graph initialises in app order (agentToolUtils alone hits a cycle).
import '../../tools.js'
import { filterToolsForAgent, resolveAgentTools } from './agentToolUtils.js'
import { AGENT_TOOL_NAME } from './constants.js'

const tools = [{ name: AGENT_TOOL_NAME }, { name: 'Read' }, { name: 'Bash' }] as unknown as Tools
const names = (ts: Tools) => ts.map(t => t.name)

describe('one level of nested agents', () => {
  test('a subagent loses the Agent tool by default', () => {
    expect(names(filterToolsForAgent({ tools, isBuiltIn: true }))).not.toContain(AGENT_TOOL_NAME)
  })
  test('a first-level subagent keeps it, also when async', () => {
    expect(names(filterToolsForAgent({ tools, isBuiltIn: true, allowAgentTool: true }))).toContain(AGENT_TOOL_NAME)
    expect(names(filterToolsForAgent({ tools, isBuiltIn: false, isAsync: true, allowAgentTool: true }))).toContain(AGENT_TOOL_NAME)
  })
  test('an explicit tools list with Agent resolves it only when nesting is allowed', () => {
    const def = { tools: [AGENT_TOOL_NAME, 'Read'], source: 'userSettings' } as never
    expect(names(resolveAgentTools(def, tools, false, false, true).resolvedTools)).toEqual([AGENT_TOOL_NAME, 'Read'])
    expect(names(resolveAgentTools(def, tools, false, false, false).resolvedTools)).toEqual(['Read'])
  })
})
