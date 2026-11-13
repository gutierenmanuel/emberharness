import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'perfil',
  description:
    'Context profile: system prompt, tools and context (CLAUDE.md, memory, hooks, MCP, skills) as one named preset',
  argumentHint: '[<nombre> | nuevo <nombre>]',
  immediate: true,
  load: () => import('./perfil.js'),
} satisfies Command
