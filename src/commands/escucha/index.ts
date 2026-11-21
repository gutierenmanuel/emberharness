import type { Command } from '../../commands.js'

const escucha = {
  type: 'local',
  name: 'escucha',
  description: 'Escucha por voz de esta sesión: lo que dices llega como mensaje tuyo (on | off | estado)',
  argumentHint: '[on|off|estado]',
  supportsNonInteractive: true,
  load: () => import('./escucha.js'),
} satisfies Command

export default escucha
