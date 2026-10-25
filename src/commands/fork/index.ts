import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'fork',
  description:
    'Run a background subagent that inherits this whole conversation and works on an instruction',
  argumentHint: '[--model <model|account:model>] <instruction>',
  immediate: true,
  load: () => import('./fork.js'),
} satisfies Command
