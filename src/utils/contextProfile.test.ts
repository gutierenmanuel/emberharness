import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_PRESETS,
  FULL_PROFILE,
  SIMPLE_PROFILE,
  cycleProfile,
  defaultProfileForAccount,
  filterMcpClientsByProfile,
  filterSkillsByProfile,
  filterToolsByProfile,
  filterWorkerToolsByProfile,
  flattenToolBlocks,
  formatProfile,
  formatTokenEstimate,
  parseScopeArgs,
  parseStoredProfile,
  scopeLookup,
  type ContextProfile,
} from './contextProfile.js'

const preset = (name: string) => CONTEXT_PRESETS.find(p => p.name === name)!.profile

const BUILTINS = ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'TodoWrite', 'WebFetch', 'Write', 'ListMcpResourcesTool', 'ReadMcpResourceTool'].map(name => ({ name }))
const MCP = [
  { name: 'mcp__proj__a', isMcp: true, mcpInfo: { serverName: 'proj', toolName: 'a' } },
  { name: 'mcp__loc__b', isMcp: true, mcpInfo: { serverName: 'loc', toolName: 'b' } },
  { name: 'mcp__usr__c', isMcp: true, mcpInfo: { serverName: 'usr', toolName: 'c' } },
  { name: 'mcp__dyn__d', isMcp: true, mcpInfo: { serverName: 'dyn', toolName: 'd' } },
]
const CLIENTS = [
  { name: 'proj', config: { scope: 'project' } },
  { name: 'loc', config: { scope: 'local' } },
  { name: 'usr', config: { scope: 'user' } },
  { name: 'dyn', config: { scope: 'dynamic' } },
]
const names = (p: ContextProfile) => filterToolsByProfile([...BUILTINS, ...MCP], p, scopeLookup(CLIENTS)).map(t => t.name).sort()

describe('presets and cycle', () => {
  test('Ctrl+Tab order is Full → Folder → User → Simple → Nothing → Full', () => {
    const seen: string[] = []
    let p = FULL_PROFILE
    for (let i = 0; i < 6; i++) {
      seen.push(formatProfile(p))
      p = cycleProfile(p)
    }
    expect(seen).toEqual(['full', 'folder', 'user', 'simple', 'nothing', 'full'])
  })
  test('backwards and from a custom combination', () => {
    expect(formatProfile(cycleProfile(FULL_PROFILE, -1))).toBe('nothing')
    const custom = { mcp: 'user', skill: 'none', tools: 'simple' } as const
    expect(formatProfile(custom)).toBe('mcp:user skill:none tools:simple')
    expect(cycleProfile(custom, 1)).toEqual(FULL_PROFILE)
    expect(formatProfile(cycleProfile(custom, -1))).toBe('nothing')
  })
  test('preset definitions', () => {
    expect(preset('folder')).toEqual({ mcp: 'folder', skill: 'folder', tools: 'full' })
    expect(preset('user')).toEqual({ mcp: 'user', skill: 'user', tools: 'full' })
    expect(SIMPLE_PROFILE).toEqual({ mcp: 'none', skill: 'none', tools: 'simple' })
    expect(preset('nothing')).toEqual({ mcp: 'none', skill: 'none', tools: 'none' })
  })
})

describe('parseScopeArgs', () => {
  test('empty shows, presets and aliases set', () => {
    expect(parseScopeArgs('  ', FULL_PROFILE)).toEqual({ kind: 'show' })
    expect(parseScopeArgs('simple', FULL_PROFILE)).toEqual({ kind: 'set', profile: SIMPLE_PROFILE })
    expect(parseScopeArgs('Nada', FULL_PROFILE)).toEqual({ kind: 'set', profile: preset('nothing') })
  })
  test('axes change the current profile; a leading preset is the base', () => {
    expect(parseScopeArgs('mcp:folder skill:user tools:simple', FULL_PROFILE)).toEqual({
      kind: 'set',
      profile: { mcp: 'folder', skill: 'user', tools: 'simple' },
    })
    expect(parseScopeArgs('tools:none', SIMPLE_PROFILE)).toEqual({ kind: 'set', profile: preset('nothing') })
    expect(parseScopeArgs('user tools=simple', FULL_PROFILE)).toEqual({
      kind: 'set',
      profile: { mcp: 'user', skill: 'user', tools: 'simple' },
    })
    expect(parseScopeArgs('skills:none', FULL_PROFILE)).toEqual({ kind: 'set', profile: { ...FULL_PROFILE, skill: 'none' } })
  })
  test('errors', () => {
    expect(parseScopeArgs('tools:folder', FULL_PROFILE).kind).toBe('error')
    expect(parseScopeArgs('bogus', FULL_PROFILE).kind).toBe('error')
  })
})

describe('stored profile and account defaults', () => {
  test('parseStoredProfile accepts objects and strings, rejects junk', () => {
    expect(parseStoredProfile({ mcp: 'user', skill: 'none', tools: 'simple' })).toEqual({ mcp: 'user', skill: 'none', tools: 'simple' })
    expect(parseStoredProfile('simple')).toEqual(SIMPLE_PROFILE)
    expect(parseStoredProfile({ mcp: 'x', skill: 'none', tools: 'simple' })).toBeUndefined()
    expect(parseStoredProfile(undefined)).toBeUndefined()
    expect(parseStoredProfile('')).toBeUndefined()
  })
  test('claude → Full, local backends → Simple, hosted → Full', () => {
    expect(defaultProfileForAccount('claude', false)).toEqual(FULL_PROFILE)
    expect(defaultProfileForAccount('qwen36', true)).toEqual(SIMPLE_PROFILE)
    expect(defaultProfileForAccount('openrouter', false)).toEqual(FULL_PROFILE)
  })
})

describe('filters', () => {
  test('Full keeps everything', () => {
    expect(names(FULL_PROFILE).length).toBe(BUILTINS.length + MCP.length)
  })
  test('Simple sends exactly the six basic tools', () => {
    expect(names(SIMPLE_PROFILE)).toEqual(['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
  })
  test('Nothing sends no tools', () => {
    expect(names(preset('nothing'))).toEqual([])
  })
  test('MCP by scope: folder = project+local, user = user, unknown only in full', () => {
    const mcpOf = (p: ContextProfile) => names(p).filter(n => n.startsWith('mcp__'))
    expect(mcpOf(preset('folder'))).toEqual(['mcp__loc__b', 'mcp__proj__a'])
    expect(mcpOf(preset('user'))).toEqual(['mcp__usr__c'])
    expect(mcpOf({ mcp: 'user', skill: 'none', tools: 'none' })).toEqual(['mcp__usr__c'])
  })
  test('skill:none drops the Skill tool; mcp:none drops the MCP resource tools', () => {
    const n = names({ mcp: 'none', skill: 'none', tools: 'full' })
    expect(n).not.toContain('Skill')
    expect(n).not.toContain('ListMcpResourcesTool')
    expect(n).toContain('Agent')
  })
  test('workers keep built-ins but follow the mcp/skill axes', () => {
    const w = filterWorkerToolsByProfile([...BUILTINS, ...MCP], preset('folder'), CLIENTS).map(t => t.name)
    expect(w).toContain('Agent')
    expect(w).not.toContain('mcp__usr__c')
  })
  test('MCP clients and skills by origin', () => {
    expect(filterMcpClientsByProfile(CLIENTS, preset('user')).map(c => c.name)).toEqual(['usr'])
    expect(filterMcpClientsByProfile(CLIENTS, SIMPLE_PROFILE)).toEqual([])
    const skills = [
      { name: 'p', source: 'projectSettings' },
      { name: 'l', source: 'localSettings' },
      { name: 'u', source: 'userSettings' },
      { name: 'b', source: 'bundled' },
      { name: 'g', source: 'plugin' },
    ]
    expect(filterSkillsByProfile(skills, preset('folder')).map(s => s.name)).toEqual(['p', 'l'])
    expect(filterSkillsByProfile(skills, preset('user')).map(s => s.name)).toEqual(['u'])
    expect(filterSkillsByProfile(skills, FULL_PROFILE).length).toBe(5)
    expect(filterSkillsByProfile(skills, SIMPLE_PROFILE)).toEqual([])
    expect(filterSkillsByProfile(skills, undefined).length).toBe(5)
  })
})

describe('helpers', () => {
  test('formatTokenEstimate', () => {
    expect(formatTokenEstimate(850)).toBe('~850 tok')
    expect(formatTokenEstimate(3000)).toBe('~3k tok')
    expect(formatTokenEstimate(3456)).toBe('~3.5k tok')
    expect(formatTokenEstimate(23456)).toBe('~23k tok')
  })
  test('flattenToolBlocks turns tool_use/tool_result into text', () => {
    const msgs = [
      { type: 'user', message: { role: 'user', content: 'hola' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'voy' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } },
    ]
    const out = flattenToolBlocks(msgs)
    expect(out[0]).toBe(msgs[0])
    expect(JSON.stringify(out)).not.toContain('tool_use"')
    expect((out[1]!.message.content as Array<{ text: string }>)[1]!.text).toBe('[tool call Bash: {"command":"ls"}]')
    expect((out[2]!.message.content as Array<{ text: string }>)[0]!.text).toBe('[tool result]\na.txt')
  })
})
