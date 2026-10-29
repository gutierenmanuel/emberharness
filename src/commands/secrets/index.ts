import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'secrets',
  description: 'Manage API keys in secret managers (pass, env, file, keyring, command)',
  argumentHint:
    '[list | backends | set <account> <manager> [ref] | use <account> <manager:ref> | move <account> <manager> [ref] | test <account> | rm <account> [--purge]]',
  immediate: true,
  load: () => import('./secrets.js'),
} satisfies Command
