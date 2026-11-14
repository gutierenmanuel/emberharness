import axios from 'axios'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getClaudeAIOAuthTokens, getOauthAccountInfo } from 'src/utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getClaudeConfigHomeDir, isEnvDefinedFalsy } from 'src/utils/envUtils.js'
import { clearMcpAuthCache } from './client.js'
import { normalizeNameForMCP } from './normalization.js'
import type { ScopedMcpServerConfig } from './types.js'

type ClaudeAIMcpServer = {
  type: 'mcp_server'
  id: string
  display_name: string
  url: string
  created_at: string
}

type ClaudeAIMcpServersResponse = {
  data: ClaudeAIMcpServer[]
  has_more: boolean
  next_page: string | null
}

const FETCH_TIMEOUT_MS = 5000

// Disk copy of the last successful list, for -p mode only (see fetchClaudeAIMcpConfigsCachedFirst).
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

type ListCache = { at: number; account: string; baseUrl: string; configs: Record<string, ScopedMcpServerConfig> }

function listCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'claudeai-mcp-cache.json')
}

/** Which account and API the cached list belongs to; a different one invalidates it. */
function listCacheOwner(): { account: string; baseUrl: string } {
  return { account: getOauthAccountInfo()?.accountUuid ?? '', baseUrl: getOauthConfig().BASE_API_URL }
}

function readListCache(): Record<string, ScopedMcpServerConfig> | null {
  try {
    const c = JSON.parse(readFileSync(listCachePath(), 'utf8')) as ListCache
    const { account, baseUrl } = listCacheOwner()
    if (!account || c.account !== account || c.baseUrl !== baseUrl) return null
    if (Date.now() - c.at > CACHE_MAX_AGE_MS) return null
    if (!c.configs || typeof c.configs !== 'object' || Object.keys(c.configs).length === 0) return null
    return c.configs
  } catch {
    return null
  }
}

function writeListCache(configs: Record<string, ScopedMcpServerConfig>): void {
  try {
    const { account, baseUrl } = listCacheOwner()
    if (!account || Object.keys(configs).length === 0) return
    const path = listCachePath()
    mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), account, baseUrl, configs } satisfies ListCache), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // A cache that cannot be written only costs the next start its speed-up.
  }
}
const MCP_SERVERS_BETA_HEADER = 'mcp-servers-2025-12-04'

/**
 * Fetches MCP server configurations from Claude.ai org configs.
 * These servers are managed by the organization via Claude.ai.
 *
 * Results are memoized for the session lifetime (fetch once per CLI session).
 */
export const fetchClaudeAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    try {
      if (isEnvDefinedFalsy(process.env.ENABLE_CLAUDEAI_MCP_SERVERS)) {
        logForDebugging('[claudeai-mcp] Disabled via env var')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'disabled_env_var' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const tokens = getClaudeAIOAuthTokens()
      if (!tokens?.accessToken) {
        logForDebugging('[claudeai-mcp] No access token')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'no_oauth_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      // Check for user:mcp_servers scope directly instead of isClaudeAISubscriber().
      // In non-interactive mode, isClaudeAISubscriber() returns false when ANTHROPIC_API_KEY
      // is set (even with valid OAuth tokens) because preferThirdPartyAuthentication() causes
      // isAnthropicAuthEnabled() to return false. Checking the scope directly allows users
      // with both API keys and OAuth tokens to access claude.ai MCPs in print mode.
      if (!tokens.scopes?.includes('user:mcp_servers')) {
        logForDebugging(
          `[claudeai-mcp] Missing user:mcp_servers scope (scopes=${tokens.scopes?.join(',') || 'none'})`,
        )
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'missing_scope' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const baseUrl = getOauthConfig().BASE_API_URL
      const url = `${baseUrl}/v1/mcp_servers?limit=1000`

      logForDebugging(`[claudeai-mcp] Fetching from ${url}`)

      const response = await axios.get<ClaudeAIMcpServersResponse>(url, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'anthropic-beta': MCP_SERVERS_BETA_HEADER,
          'anthropic-version': '2023-06-01',
        },
        timeout: FETCH_TIMEOUT_MS,
      })

      const configs: Record<string, ScopedMcpServerConfig> = {}
      // Track used normalized names to detect collisions and assign (2), (3), etc. suffixes.
      // We check the final normalized name (including suffix) to handle edge cases where
      // a suffixed name collides with another server's base name (e.g., "Example Server 2"
      // colliding with "Example Server! (2)" which both normalize to claude_ai_Example_Server_2).
      const usedNormalizedNames = new Set<string>()

      for (const server of response.data.data) {
        const baseName = `claude.ai ${server.display_name}`

        // Try without suffix first, then increment until we find an unused normalized name
        let finalName = baseName
        let finalNormalized = normalizeNameForMCP(finalName)
        let count = 1
        while (usedNormalizedNames.has(finalNormalized)) {
          count++
          finalName = `${baseName} (${count})`
          finalNormalized = normalizeNameForMCP(finalName)
        }
        usedNormalizedNames.add(finalNormalized)

        configs[finalName] = {
          type: 'claudeai-proxy',
          url: server.url,
          id: server.id,
          scope: 'claudeai',
        }
      }

      logForDebugging(
        `[claudeai-mcp] Fetched ${Object.keys(configs).length} servers`,
      )
      logEvent('tengu_claudeai_mcp_eligibility', {
        state:
          'eligible' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      writeListCache(configs)
      return configs
    } catch {
      logForDebugging(`[claudeai-mcp] Fetch failed`)
      return {}
    }
  },
)

/**
 * -p mode: the connector list without waiting for the network. The list rarely changes and fetching it
 * costs 0.3-0.8 s that sat on the critical path before the first turn, so a copy from the last
 * successful fetch is used right away while the real fetch refreshes it in the background (a connector
 * added or removed on claude.ai shows up one run later). With no usable copy it waits for the fetch as before.
 * `FNHARNESS_CLAUDEAI_MCP_NO_CACHE=1` forces the old behaviour.
 */
export function fetchClaudeAIMcpConfigsCachedFirst(): Promise<Record<string, ScopedMcpServerConfig>> {
  const fresh = fetchClaudeAIMcpConfigsIfEligible()
  if (process.env.FNHARNESS_CLAUDEAI_MCP_NO_CACHE === '1') return fresh
  const cached = readListCache()
  if (!cached) return fresh
  logForDebugging(`[claudeai-mcp] Using cached list (${Object.keys(cached).length} servers); refreshing in the background`)
  void fresh.catch(() => {})
  return Promise.resolve(cached)
}

/**
 * Clears the memoized cache for fetchClaudeAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
export function clearClaudeAIMcpConfigsCache(): void {
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  // Also clear the auth cache so freshly-authorized servers get re-connected
  clearMcpAuthCache()
}

/**
 * Record that a claude.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
    const seen = current.claudeAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...seen, name] }
  })
}

export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().claudeAiMcpEverConnected ?? []).includes(name)
}
