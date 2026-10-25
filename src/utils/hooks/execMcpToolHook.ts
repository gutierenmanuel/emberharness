import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { McpToolHook } from '../../schemas/hooks.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'

let dynamicMcpConfig: Record<string, unknown> = {}

/** Servers given with --mcp-config; they are not in any settings scope. */
export function setHookDynamicMcpConfig(cfg: Record<string, unknown>): void {
  dynamicMcpConfig = cfg
}

/** Default `mcp_tool` timeout (s); the official docs lower it for some events. */
export function mcpToolHookTimeoutSeconds(
  hook: McpToolHook,
  hookEvent: HookEvent,
): number {
  if (hook.timeout) return hook.timeout
  switch (hookEvent) {
    case 'UserPromptSubmit':
    case 'PreModelSwitch':
    case 'PostModelSwitch':
      return 30
    case 'MessageDisplay':
      return 10
    default:
      return 600
  }
}

function lookup(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * Pure: replaces `${path}` in every string of `value` with the matching field
 * of the hook input (dot paths). Unresolved paths become ''. Non-string leaves
 * are kept; objects and arrays are walked.
 */
export function substituteHookInput(
  value: unknown,
  hookInput: unknown,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_m, path: string) => {
      const found = lookup(hookInput, path.trim())
      if (found === undefined || found === null) return ''
      return typeof found === 'string' ? found : JSON.stringify(found)
    })
  }
  if (Array.isArray(value)) return value.map(v => substituteHookInput(v, hookInput))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteHookInput(v, hookInput)]),
    )
  }
  return value
}

/** Pure: text of an MCP tool result (text blocks joined by newlines). */
export function mcpResultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        !!c && c.type === 'text' && typeof c.text === 'string',
    )
    .map(c => c.text)
    .join('\n')
}

/**
 * Executes an `mcp_tool` hook: calls `hook.tool` on the configured MCP server
 * `hook.server` with `hook.input` after `${path}` substitution. Same result
 * shape as execHttpHook; the caller interprets `body` like command stdout.
 * `isError: true` from the tool is a non-blocking error (`ok: false`).
 */
export async function execMcpToolHook(
  hook: McpToolHook,
  hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  body: string
  error?: string
  aborted?: boolean
}> {
  const timeoutMs = mcpToolHookTimeoutSeconds(hook, hookEvent) * 1000
  const { signal: combined, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })
  try {
    let hookInput: unknown = {}
    try {
      hookInput = JSON.parse(jsonInput)
    } catch {
      // keep {}
    }
    const args = (substituteHookInput(hook.input ?? {}, hookInput) ??
      {}) as Record<string, unknown>

    // Dynamic imports: hooks.ts is loaded long before the MCP layer.
    const { getMcpConfigByName, getAllMcpConfigs } = await import(
      '../../services/mcp/config.js'
    )
    const { connectToServer } = await import('../../services/mcp/client.js')
    let config =
      (dynamicMcpConfig[hook.server] as ReturnType<typeof getMcpConfigByName>) ??
      getMcpConfigByName(hook.server)
    if (!config) {
      const all = await getAllMcpConfigs()
      config = all.servers[hook.server] ?? null
    }
    if (!config) {
      return { ok: false, body: '', error: `MCP server "${hook.server}" is not configured` }
    }
    const connection = await connectToServer(hook.server, config)
    if (connection.type !== 'connected') {
      return {
        ok: false,
        body: '',
        error: `MCP server "${hook.server}" is not connected`,
      }
    }
    const result = await connection.client.callTool(
      { name: hook.tool, arguments: args },
      undefined,
      { signal: combined, timeout: timeoutMs },
    )
    const body = mcpResultText(result)
    if ('isError' in result && result.isError) {
      return { ok: false, body, error: body || `MCP tool "${hook.tool}" returned an error` }
    }
    return { ok: true, body }
  } catch (e) {
    if (signal?.aborted) return { ok: false, body: '', aborted: true }
    logForDebugging(`mcp_tool hook failed: ${errorMessage(e)}`, { level: 'error' })
    return { ok: false, body: '', error: errorMessage(e) }
  } finally {
    cleanup?.()
  }
}
