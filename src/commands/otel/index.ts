import type { Command } from '../../commands.js'

const otel = {
  type: 'local',
  name: 'otel',
  aliases: ['opentelemetry', 'telemetry'],
  description:
    'Show what happens with telemetry (OpenTelemetry) right now and where it would be sent; read-only',
  argumentHint: '[--json]',
  supportsNonInteractive: true,
  load: () => import('./otel.js'),
} satisfies Command

export default otel
