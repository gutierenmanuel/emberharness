import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP servers',
  immediate: true,
  argumentHint: '[reload [server] | reconnect <server|all> | enable|disable [server]]',
  load: () => import('./mcp.js'),
} satisfies Command

export default mcp
