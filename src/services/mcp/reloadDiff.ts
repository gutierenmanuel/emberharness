/**
 * Pure helpers for hot-reloading MCP server configs: what changed between the
 * servers currently loaded and the ones the config files describe now, and how
 * to print that. No I/O, no React; everything here is covered by unit tests.
 */
import type { ScopedMcpServerConfig } from './types.js'
import { hashMcpConfig, isPrunableScope } from './utils.js'

export type McpConfigDiff = {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

/**
 * Compares the loaded servers with the freshly read configs. A server is
 * `changed` when the content hash differs (scope is ignored, as in
 * `hashMcpConfig`); `removed` only counts prunable scopes.
 */
export function diffMcpConfigs(
  current: ReadonlyArray<{ name: string; config: ScopedMcpServerConfig }>,
  next: Readonly<Record<string, ScopedMcpServerConfig>>,
): McpConfigDiff {
  const diff: McpConfigDiff = { added: [], removed: [], changed: [], unchanged: [] }
  const seen = new Set<string>()
  for (const { name, config } of current) {
    seen.add(name)
    const fresh = next[name]
    if (!fresh) {
      if (isPrunableScope(config.scope)) diff.removed.push(name)
      continue
    }
    if (hashMcpConfig(config) !== hashMcpConfig(fresh)) diff.changed.push(name)
    else diff.unchanged.push(name)
  }
  for (const name of Object.keys(next)) {
    if (!seen.has(name)) diff.added.push(name)
  }
  for (const list of [diff.added, diff.removed, diff.changed, diff.unchanged]) list.sort()
  return diff
}

export function isEmptyDiff(diff: McpConfigDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length === 0
}

/** One-line system notice: "MCP: +foo, ~bar, -baz". Empty string when nothing changed. */
export function formatMcpDiffNotice(diff: McpConfigDiff): string {
  if (isEmptyDiff(diff)) return ''
  const parts = [
    ...diff.added.map(n => `+${n}`),
    ...diff.changed.map(n => `~${n}`),
    ...diff.removed.map(n => `-${n}`),
  ]
  return `MCP: ${parts.join(', ')}`
}

/** Multi-line report printed by `/mcp reload`. */
export function formatMcpReloadReport(diff: McpConfigDiff, warnings: string[] = []): string {
  const lines: string[] = []
  if (isEmptyDiff(diff)) {
    lines.push(
      diff.unchanged.length > 0
        ? `MCP: config reloaded, no changes (${diff.unchanged.length} unchanged)`
        : 'MCP: config reloaded, no servers configured',
    )
  } else {
    lines.push('MCP: config reloaded')
    if (diff.added.length) lines.push(`  added: ${diff.added.join(', ')}`)
    if (diff.changed.length) lines.push(`  changed: ${diff.changed.join(', ')}`)
    if (diff.removed.length) lines.push(`  removed: ${diff.removed.join(', ')}`)
    if (diff.unchanged.length) lines.push(`  unchanged: ${diff.unchanged.join(', ')}`)
  }
  for (const w of warnings) lines.push(`  warning: ${w}`)
  return lines.join('\n')
}

/**
 * A reload must not touch live connections when a config file is half written
 * or broken: the parser then drops the whole file, which would look like every
 * server was removed. Fatal parse errors (invalid JSON, unreadable file, schema
 * failure of the file itself) abort the reload. A missing file is normal.
 */
export function hasBlockingConfigErrors(
  errors: ReadonlyArray<{
    message: string
    mcpErrorMetadata?: { severity?: string }
  }>,
): boolean {
  return errors.some(
    e =>
      e.mcpErrorMetadata?.severity === 'fatal' &&
      !e.message.startsWith('MCP config file not found'),
  )
}
