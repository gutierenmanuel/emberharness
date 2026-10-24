import type { Command } from '../../commands.js'

const recap = {
  type: 'local',
  name: 'recap',
  description: 'One-line summary of where this session stands',
  supportsNonInteractive: false,
  load: () => import('./recap.js'),
} satisfies Command

export default recap
