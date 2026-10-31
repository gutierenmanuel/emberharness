import { describe, expect, test } from 'bun:test'
import type { Tools } from '../../Tool.js'
// Loaded first so the Agent tool module graph initialises in app order (agentToolUtils alone hits a cycle).
import '../../tools.js'
import { extractAgentReport, filterToolsForAgent, resolveAgentTools } from './agentToolUtils.js'
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

describe('the report a subagent hands its parent', () => {
  const asst = (...content: object[]) => ({ type: 'assistant', message: { content } }) as never
  const user = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } } as never
  test('the final text when there is one', () => {
    const r = extractAgentReport([asst({ type: 'text', text: 'Mirando…' }), user, asst({ type: 'text', text: 'Resultado: 3' })], 1)
    expect(r).toEqual([{ type: 'text', text: 'Resultado: 3' }])
  })
  test('says it stopped without a report and quotes the last text', () => {
    const r = extractAgentReport([asst({ type: 'text', text: 'Voy a leer el fichero' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }), user, asst({ type: 'tool_use', id: 'u', name: 'Read', input: {} })], 2)
    expect(r[0]!.text).toContain('stopped without a final report after 2 tool uses')
    expect(r[0]!.text).toContain('Voy a leer el fichero')
  })
  test('never empty, even with no text at all', () => {
    const r = extractAgentReport([asst({ type: 'tool_use', id: 't', name: 'Bash', input: {} })], 1)
    expect(r[0]!.text).toContain('without writing any text')
  })
})
