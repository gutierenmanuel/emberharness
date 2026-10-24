/**
 * Tells the model when the tools of an MCP server changed mid-conversation
 * (server added, edited, removed, reconnected with another tool set).
 *
 * The tracker remembers, per conversation, the MCP tool names the model has
 * last seen. On each turn it compares them with the tools the request really
 * carries and reports only a genuine difference, so nothing is injected (and
 * no prompt-cache prefix is touched) when the set is unchanged. The first
 * observation of a conversation only records the baseline.
 */
import { mcpInfoFromString } from './mcpStringUtils.js'

export type McpToolChange = {
  server: string
  added: string[]
  removed: string[]
}

/** server -> sorted short tool names, built from fully qualified `mcp__srv__tool` names. */
export function groupMcpTools(names: Iterable<string>): Map<string, string[]> {
  const byServer = new Map<string, string[]>()
  for (const full of names) {
    const info = mcpInfoFromString(full)
    if (!info?.toolName) continue
    const list = byServer.get(info.serverName) ?? []
    list.push(info.toolName)
    byServer.set(info.serverName, list)
  }
  for (const list of byServer.values()) list.sort()
  return byServer
}

export function diffMcpToolSets(
  prev: ReadonlyMap<string, readonly string[]>,
  next: ReadonlyMap<string, readonly string[]>,
): McpToolChange[] {
  const changes: McpToolChange[] = []
  for (const server of new Set([...prev.keys(), ...next.keys()])) {
    const before = new Set(prev.get(server) ?? [])
    const after = new Set(next.get(server) ?? [])
    const added = [...after].filter(t => !before.has(t)).sort()
    const removed = [...before].filter(t => !after.has(t)).sort()
    if (added.length > 0 || removed.length > 0) changes.push({ server, added, removed })
  }
  return changes.sort((a, b) => a.server.localeCompare(b.server))
}

/** Text of the meta message (wrapped in a system reminder by the caller). */
export function formatMcpToolsChanged(changes: readonly McpToolChange[]): string {
  const lines = changes.map(c => {
    const parts: string[] = []
    if (c.added.length > 0) parts.push(`now available: ${c.added.map(t => `mcp__${c.server}__${t}`).join(', ')}`)
    if (c.removed.length > 0) parts.push(`no longer available: ${c.removed.map(t => `mcp__${c.server}__${t}`).join(', ')}`)
    return `- MCP server "${c.server}": ${parts.join('; ')}`
  })
  return `The tools of some MCP servers changed (the user edited the MCP config or a server restarted). Your tool list is already up to date; do not call tools listed as no longer available.\n${lines.join('\n')}`
}

export function createMcpToolsTracker() {
  let key: string | null = null
  let snapshot: Map<string, string[]> | null = null
  return {
    /**
     * `conversationKey` identifies the conversation (a /clear or a compaction
     * changes it and re-baselines). Returns the changes since the last call.
     */
    observe(conversationKey: string, toolNames: Iterable<string>): McpToolChange[] {
      const next = groupMcpTools(toolNames)
      if (snapshot === null || key !== conversationKey) {
        key = conversationKey
        snapshot = next
        return []
      }
      const changes = diffMcpToolSets(snapshot, next)
      snapshot = next
      return changes
    },
    reset() {
      key = null
      snapshot = null
    },
  }
}

/** Process-wide tracker used by the attachments pipeline. */
export const mcpToolsTracker = createMcpToolsTracker()
