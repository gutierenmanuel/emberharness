import type { Command } from '../../commands.js'

const peers = {
  type: 'local',
  name: 'peers',
  description:
    'List the other fnharness sessions on this machine, or send one a message',
  argumentHint: '[send <pid|session|name|parent> <message>]',
  supportsNonInteractive: true,
  load: () => import('./peers.js'),
} satisfies Command

export default peers
