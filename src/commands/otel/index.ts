import type { Command } from '../../commands.js'

const otel = {
  type: 'local-jsx',
  name: 'otel',
  aliases: ['opentelemetry', 'telemetry'],
  description:
    'Telemetry (OpenTelemetry): interactive picker of receivers — toggle, bind accounts, signals and flags; `test <id>` sends a test point, `add` declares a receiver, `--json` the full report',
  argumentHint: '[--json] | test <id> | add <id> <endpoint> --accounts <a,b>',
  immediate: true,
  supportsNonInteractive: true,
  load: () => import('./otel.js'),
} satisfies Command

export default otel
