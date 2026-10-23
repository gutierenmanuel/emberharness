import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'account',
  description:
    'Switch the active account/backend (claude, llamacpp, openai, openrouter, ...)',
  argumentHint: '[list | <id> [model] | key <id> <apikey> | add <id> <baseUrl> [model] | remove <id>]',
  immediate: true,
  load: () => import('./account.js'),
} satisfies Command
