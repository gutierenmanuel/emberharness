import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'account',
  description:
    'Switch the active account/backend (claude, llamacpp, openai, openrouter, ...)',
  argumentHint: '[list | catalog [text] | <id> [model] | default <id|last> [model] | key <id> <apikey> | add <id> <baseUrl> [model] | add <provider> [id] [model] | remove <id>]',
  immediate: true,
  load: () => import('./account.js'),
} satisfies Command
