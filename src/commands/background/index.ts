import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'background',
  aliases: ['bg'],
  description: 'Run a prompt in a detached background session that forks this conversation',
  argumentHint: '<prompt>',
  immediate: true,
  load: () => import('./background.js'),
} satisfies Command
