import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'subtask',
  description:
    'Run a background subagent with a clean context (no conversation history) on an instruction',
  argumentHint: '[--model <model|account:model>] <instruction>',
  immediate: true,
  load: () => import('./subtask.js'),
} satisfies Command
