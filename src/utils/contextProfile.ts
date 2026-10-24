/**
 * Context profile: decides what reaches the model on each request.
 *
 * Three independent axes:
 *   mcp    full | folder | user | none   which MCP servers' tools (by config scope)
 *   skill  full | folder | user | none   which skills/commands the model sees
 *   tools  full | simple | none          which built-in tools are sent
 *
 * Everything in this file is pure (no fs, no state) so it can be unit tested;
 * persistence lives in contextProfileStore.ts.
 */

export type McpAxis = 'full' | 'folder' | 'user' | 'none'
export type SkillAxis = 'full' | 'folder' | 'user' | 'none'
export type ToolsAxis = 'full' | 'simple' | 'none'

export type ContextProfile = {
  mcp: McpAxis
  skill: SkillAxis
  tools: ToolsAxis
}

export const MCP_AXIS_VALUES: readonly McpAxis[] = ['full', 'folder', 'user', 'none']
export const SKILL_AXIS_VALUES: readonly SkillAxis[] = ['full', 'folder', 'user', 'none']
export const TOOLS_AXIS_VALUES: readonly ToolsAxis[] = ['full', 'simple', 'none']

export type PresetName = 'full' | 'folder' | 'user' | 'simple' | 'nothing'

/** Presets in the order Ctrl+Tab rotates through them. */
export const CONTEXT_PRESETS: ReadonlyArray<{ name: PresetName; label: string; profile: ContextProfile }> = [
  { name: 'full', label: 'Full', profile: { mcp: 'full', skill: 'full', tools: 'full' } },
  { name: 'folder', label: 'Folder', profile: { mcp: 'folder', skill: 'folder', tools: 'full' } },
  { name: 'user', label: 'User', profile: { mcp: 'user', skill: 'user', tools: 'full' } },
  { name: 'simple', label: 'Simple', profile: { mcp: 'none', skill: 'none', tools: 'simple' } },
  { name: 'nothing', label: 'Nothing', profile: { mcp: 'none', skill: 'none', tools: 'none' } },
]

export const FULL_PROFILE: ContextProfile = CONTEXT_PRESETS[0]!.profile
export const SIMPLE_PROFILE: ContextProfile = CONTEXT_PRESETS[3]!.profile

/** Built-in tools kept by `tools:simple` (Agent lets local sessions spawn subagents). */
export const SIMPLE_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent'])

const SKILL_TOOL_NAME = 'Skill'
const MCP_RESOURCE_TOOL_NAMES = new Set(['ListMcpResourcesTool', 'ReadMcpResourceTool'])

const PRESET_ALIASES: Record<string, PresetName> = {
  full: 'full',
  todo: 'full',
  folder: 'folder',
  carpeta: 'folder',
  project: 'folder',
  user: 'user',
  usuario: 'user',
  simple: 'simple',
  nothing: 'nothing',
  none: 'nothing',
  nada: 'nothing',
  chat: 'nothing',
}

export function sameProfile(a: ContextProfile, b: ContextProfile): boolean {
  return a.mcp === b.mcp && a.skill === b.skill && a.tools === b.tools
}

/** Preset that matches `p` exactly, or null for a custom combination. */
export function presetOf(p: ContextProfile): (typeof CONTEXT_PRESETS)[number] | null {
  return CONTEXT_PRESETS.find(x => sameProfile(x.profile, p)) ?? null
}

/** `simple` for a preset, `mcp:user skill:none tools:simple` otherwise. */
export function formatProfile(p: ContextProfile): string {
  return presetOf(p)?.name ?? `mcp:${p.mcp} skill:${p.skill} tools:${p.tools}`
}

/** Short form for the footer: preset name or `m:user s:none t:simple`. */
export function formatProfileShort(p: ContextProfile): string {
  return presetOf(p)?.name ?? `m:${p.mcp} s:${p.skill} t:${p.tools}`
}

/**
 * Next preset in the Ctrl+Tab rotation (`dir` = -1 goes backwards). A custom
 * combination jumps to Full going forward and to Nothing going backwards.
 */
export function cycleProfile(p: ContextProfile, dir: 1 | -1 = 1): ContextProfile {
  const i = CONTEXT_PRESETS.findIndex(x => sameProfile(x.profile, p))
  const n = CONTEXT_PRESETS.length
  if (i < 0) return CONTEXT_PRESETS[dir === 1 ? 0 : n - 1]!.profile
  return CONTEXT_PRESETS[(i + dir + n) % n]!.profile
}

export type ScopeArgs =
  | { kind: 'show' }
  | { kind: 'set'; profile: ContextProfile }
  | { kind: 'error'; message: string }

/**
 * Parses `/scope` arguments against the current profile:
 *   ''                         -> show
 *   'simple'                   -> preset
 *   'mcp:folder tools:simple'  -> current profile with those axes changed
 *   'user tools:simple'        -> preset, then overrides
 */
export function parseScopeArgs(args: string, current: ContextProfile): ScopeArgs {
  const tokens = args.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'show' }
  let profile: ContextProfile = { ...current }
  for (const tok of tokens) {
    const m = /^(mcp|skills?|tools?)[:=](.+)$/.exec(tok)
    if (!m) {
      const preset = PRESET_ALIASES[tok]
      if (!preset) {
        return { kind: 'error', message: `No entiendo "${tok}". Presets: ${CONTEXT_PRESETS.map(x => x.name).join(', ')}; ejes: mcp:<full|folder|user|none> skill:<full|folder|user|none> tools:<full|simple|none>` }
      }
      profile = { ...CONTEXT_PRESETS.find(x => x.name === preset)!.profile }
      continue
    }
    const axis = m[1]!.startsWith('skill') ? 'skill' : m[1]!.startsWith('tool') ? 'tools' : 'mcp'
    const value = m[2]!
    const allowed: readonly string[] = axis === 'tools' ? TOOLS_AXIS_VALUES : MCP_AXIS_VALUES
    if (!allowed.includes(value)) {
      return { kind: 'error', message: `${axis}:${value} no vale; usa ${axis}:<${allowed.join('|')}>` }
    }
    profile = { ...profile, [axis]: value } as ContextProfile
  }
  return { kind: 'set', profile }
}

/** Validates a profile read from disk or env; undefined if it is not one. */
export function parseStoredProfile(raw: unknown): ContextProfile | undefined {
  if (typeof raw === 'string') {
    const r = parseScopeArgs(raw, FULL_PROFILE)
    return r.kind === 'set' ? r.profile : undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (
    MCP_AXIS_VALUES.includes(o.mcp as McpAxis) &&
    SKILL_AXIS_VALUES.includes(o.skill as SkillAxis) &&
    TOOLS_AXIS_VALUES.includes(o.tools as ToolsAxis)
  ) {
    return { mcp: o.mcp as McpAxis, skill: o.skill as SkillAxis, tools: o.tools as ToolsAxis }
  }
  return undefined
}

/** Default when an account has none saved: local backends start in Simple. */
export function defaultProfileForAccount(accountId: string, isLocalBackend: boolean): ContextProfile {
  if (accountId === 'claude') return FULL_PROFILE
  return isLocalBackend ? SIMPLE_PROFILE : FULL_PROFILE
}

/** Whether an MCP server with this config scope is visible on the `mcp` axis. */
export function isMcpScopeAllowed(scope: string | undefined, axis: McpAxis): boolean {
  switch (axis) {
    case 'full':
      return true
    case 'folder':
      return scope === 'project' || scope === 'local'
    case 'user':
      return scope === 'user'
    case 'none':
      return false
  }
}

/** Whether a skill/command with this source is visible to the model on the `skill` axis. */
export function isSkillSourceAllowed(source: string | undefined, axis: SkillAxis): boolean {
  switch (axis) {
    case 'full':
      return true
    case 'folder':
      return source === 'projectSettings' || source === 'localSettings'
    case 'user':
      return source === 'userSettings'
    case 'none':
      return false
  }
}

type ToolLike = { name: string; isMcp?: boolean; mcpInfo?: { serverName: string; toolName: string } }

function isMcpToolLike(t: ToolLike): boolean {
  return t.name.startsWith('mcp__') || t.isMcp === true || t.mcpInfo !== undefined
}

/**
 * Filters a tool pool through the profile. `scopeOfServer` maps an MCP server
 * name to its config scope (undefined = unknown, only visible with mcp:full).
 */
export function filterToolsByProfile<T extends ToolLike>(
  tools: readonly T[],
  profile: ContextProfile | undefined,
  scopeOfServer: (serverName: string) => string | undefined,
): T[] {
  if (!profile || sameProfile(profile, FULL_PROFILE)) return [...tools]
  return tools.filter(t => {
    if (isMcpToolLike(t)) {
      const server = t.mcpInfo?.serverName ?? t.name.split('__')[1] ?? ''
      return isMcpScopeAllowed(scopeOfServer(server), profile.mcp)
    }
    if (MCP_RESOURCE_TOOL_NAMES.has(t.name)) return profile.tools === 'full' && profile.mcp !== 'none'
    if (t.name === SKILL_TOOL_NAME) return profile.tools === 'full' && profile.skill !== 'none'
    if (profile.tools === 'full') return true
    if (profile.tools === 'simple') return SIMPLE_TOOL_NAMES.has(t.name)
    return false
  })
}

/** Filters MCP client connections (used for server instructions) by scope. */
export function filterMcpClientsByProfile<C extends { config: { scope?: string } }>(
  clients: readonly C[],
  profile: ContextProfile | undefined,
): C[] {
  if (!profile || profile.mcp === 'full') return [...clients]
  return clients.filter(c => isMcpScopeAllowed(c.config.scope, profile.mcp))
}

/** Filters skills/commands the model may see or invoke. */
export function filterSkillsByProfile<C extends { source?: string }>(
  commands: readonly C[],
  profile: ContextProfile | undefined,
): C[] {
  if (!profile || profile.skill === 'full') return [...commands]
  return commands.filter(c => isSkillSourceAllowed(c.source, profile.skill))
}

/** `~3k tok` style rendering for the footer. */
export function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tok`
  if (tokens < 10_000) return `~${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k tok`
  return `~${Math.round(tokens / 1000)}k tok`
}

type ApiBlock = { type: string; [k: string]: unknown }
type ApiMessage = { type: string; message: { role?: string; content: unknown } }

/**
 * When a request carries no tools at all, the API rejects tool_use /
 * tool_result blocks left in the history. Rewrites them as plain text so the
 * conversation survives switching to tools:none. Messages without such
 * blocks are returned unchanged (same object).
 */
export function flattenToolBlocks<M extends ApiMessage>(messages: readonly M[]): M[] {
  return messages.map(m => {
    const content = m.message.content
    if (!Array.isArray(content)) return m
    const blocks = content as ApiBlock[]
    if (!blocks.some(b => b.type === 'tool_use' || b.type === 'tool_result')) return m
    const flat = blocks.map(b => {
      if (b.type === 'tool_use') {
        return { type: 'text', text: `[tool call ${String(b.name)}: ${JSON.stringify(b.input ?? {})}]` }
      }
      if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content)
          ? (b.content as ApiBlock[]).map(x => (x.type === 'text' ? String(x.text) : `[${x.type}]`)).join('\n')
          : String(b.content ?? '')
        return { type: 'text', text: `[tool result${b.is_error ? ' (error)' : ''}]\n${inner}` }
      }
      return b
    })
    return { ...m, message: { ...m.message, content: flat } }
  })
}

/** scopeOfServer for filterToolsByProfile, built from the MCP client list. */
export function scopeLookup(
  clients: readonly { name: string; config: { scope?: string } }[],
): (serverName: string) => string | undefined {
  const byName = new Map(clients.map(c => [c.name, c.config.scope]))
  return name => byName.get(name)
}

/**
 * Tool pool for a subagent: subagents always get the full built-ins (even
 * when the session runs tools:simple); the MCP and skill axes of the session
 * still apply.
 */
export function filterWorkerToolsByProfile<T extends ToolLike>(
  tools: readonly T[],
  profile: ContextProfile | undefined,
  clients: readonly { name: string; config: { scope?: string } }[],
): T[] {
  if (!profile) return [...tools]
  return filterToolsByProfile(tools, { ...profile, tools: 'full' }, scopeLookup(clients))
}
