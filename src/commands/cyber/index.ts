import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'cyber',
  description:
    'Modo ciberseguridad de la sesión: abre o cierra los gates y precarga la CyberMemory (/cyber on|off), o lanza una kitty dedicada sobre GLM (/cyber start)',
  argumentHint: '[on | off | status | start | help]',
  immediate: true,
  supportsNonInteractive: true,
  load: () => import('./cyber.js'),
} satisfies Command
