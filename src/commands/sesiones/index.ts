import type { Command } from '../../commands.js'

// No va detrás de ningún feature flag: el directorio de sesiones solo lee
// ficheros y procesos locales, no necesita el buzón UDS que usa /peers.
const sesiones = {
  type: 'local',
  name: 'sesiones',
  description:
    'Lista las sesiones de toda la máquina (kitty, tmux, Element, bg) con su origen y estado',
  argumentHint: '[list] [--json] [--todas]',
  supportsNonInteractive: true,
  load: () => import('./sesiones.js'),
} satisfies Command

export default sesiones
