import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Keep working turn after turn until a condition is met, checked by an evaluator',
  argumentHint: '[<condition> [--judge <account>] [--turns N] | clear]',
  immediate: true,
  supportsNonInteractive: true,
  load: () => import('./goal.js'),
} satisfies Command
