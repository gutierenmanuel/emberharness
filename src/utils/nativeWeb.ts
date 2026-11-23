import { isEnvTruthy } from './envUtils.js'

/**
 * EmberHarness: las herramientas nativas WebSearch y WebFetch solo funcionan con
 * la API de Anthropic (WebSearch usa la herramienta de servidor web_search y
 * WebFetch pasa por un modelo auxiliar) y cuestan dinero, así que van
 * desactivadas por defecto. Se reactivan con FNHARNESS_NATIVE_WEB=1.
 * En su lugar se usan las herramientas del servidor MCP `web_search`.
 */
export function isNativeWebEnabled(): boolean {
  return isEnvTruthy(process.env.FNHARNESS_NATIVE_WEB)
}

/** Nombres de las herramientas MCP que sustituyen a las nativas. */
export const MCP_WEB_SEARCH_TOOL_NAME = 'mcp__web_search__web_search'
export const MCP_WEB_FETCH_TOOL_NAME = 'mcp__web_search__web_fetch'
