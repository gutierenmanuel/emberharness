import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'account',
  description:
    'Switch the active account/backend (claude, llamacpp, openai, openrouter, ...)',
  argumentHint: '[list | add claude <id> | import <dir> --as <id> | approve <id> | doctor [--fix] | catalog [text] | <id> [model] | default <id|last> [model] | key <id> <apikey> | add <id> <baseUrl> [model] | add <provider> [id] [model] | remove <id>]',
  immediate: true,
  // list, import, doctor, default, key, add and a switch also work with -p (no picker there).
  supportsNonInteractive: true,
  load: () => import('./account.js'),
} satisfies Command
