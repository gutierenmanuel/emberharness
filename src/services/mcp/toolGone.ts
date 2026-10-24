/**
 * Text of the tool_result sent back when the model calls a tool that no longer
 * exists. For MCP tools the usual cause since hot reload is a server that was
 * removed, edited or restarted between the request and the call, so the error
 * says so instead of a bare "No such tool available".
 */
export function noSuchToolMessage(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const server = toolName.split('__')[1] ?? ''
    return `No such tool available: ${toolName}. The MCP server${server ? ` "${server}"` : ''} was removed, reloaded or is reconnecting, so this tool is gone for now. Do not retry it blindly: check the tools you currently have, or ask the user to run /mcp.`
  }
  return `No such tool available: ${toolName}`
}
