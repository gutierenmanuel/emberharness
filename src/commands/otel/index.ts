import type { Command } from '../../commands.js'

const otel = {
  type: 'local',
  name: 'otel',
  aliases: ['opentelemetry', 'telemetry'],
  description:
    'Telemetry (OpenTelemetry): receivers, bound accounts, last send and error; `test <id>` sends a test point, `add` declares a receiver',
  argumentHint: '[--json] | test <id> | add <id> <endpoint> --accounts <a,b>',
  supportsNonInteractive: true,
  load: () => import('./otel.js'),
} satisfies Command

export default otel
