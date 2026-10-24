import type { Command } from '../../commands.js'

const autocompact = {
  type: 'local',
  name: 'autocompact',
  description: 'Set the auto-compact threshold for this session',
  argumentHint: '[auto|off|<tokens>]',
  supportsNonInteractive: false,
  load: () => import('./autocompact.js'),
} satisfies Command

export default autocompact
