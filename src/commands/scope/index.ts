import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'scope',
  description:
    'Context profile: which MCP servers, skills and tools reach the model (Ctrl+Tab rotates presets)',
  argumentHint: '[full | folder | user | simple | nothing] [mcp:<full|folder|user|none>] [skill:<full|folder|user|none>] [tools:<full|simple|none>]',
  immediate: true,
  load: () => import('./scope.js'),
} satisfies Command
