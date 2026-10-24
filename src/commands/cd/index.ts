import type { Command } from '../../commands.js'

const cd = {
  type: 'local',
  name: 'cd',
  description:
    'Move the session to another directory, keeping the conversation',
  argumentHint: '<path>',
  supportsNonInteractive: false,
  load: () => import('./cd.js'),
} satisfies Command

export default cd
