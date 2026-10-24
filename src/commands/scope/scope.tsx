import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  CONTEXT_PRESETS,
  FULL_PROFILE,
  formatProfile,
  formatTokenEstimate,
  parseScopeArgs,
  presetOf,
  type ContextProfile,
} from '../../utils/contextProfile.js'
import { estimateContextProfile, type ContextEstimate } from '../../utils/contextProfileEstimate.js'
import { applyContextProfile, currentAccountId } from '../../utils/contextProfileStore.js'

const HELP = [
  '/scope                           estado y selector de presets',
  '/scope <preset>                  full · folder · user · simple · nothing',
  '/scope mcp:<v> skill:<v> tools:<v>   ejes sueltos (se pueden combinar con un preset delante)',
  '  mcp    full | folder (project/local) | user | none',
  '  skill  full | folder (.claude del proyecto) | user (~/.claude) | none',
  '  tools  full | simple (Bash Read Write Edit Glob Grep) | none (solo chat)',
  'Ctrl+Tab / Ctrl+Shift+Tab rotan Full → Folder → User → Simple → Nothing. Se recuerda por cuenta.',
].join('\n')

function describe(p: ContextProfile, est?: ContextEstimate): string {
  const cost = est ? ` · ${formatTokenEstimate(est.total)} (sistema ${est.system}, ${est.toolCount} tools ${est.tools}, skills ${est.skills})` : ''
  return `mcp:${p.mcp} skill:${p.skill} tools:${p.tools}${cost}`
}

type PickerProps = {
  current: ContextProfile
  estimates: Map<string, ContextEstimate>
  onPick: (p: ContextProfile) => void
  onCancel: () => void
}

function ScopePicker({ current, estimates, onPick, onCancel }: PickerProps): React.ReactNode {
  const options = CONTEXT_PRESETS.map(x => ({
    value: x.name,
    label: `${presetOf(current)?.name === x.name ? '●' : ' '} ${x.label.padEnd(8)}`,
    description: describe(x.profile, estimates.get(x.name)),
  }))
  return (
    <Dialog
      title="Perfil de contexto"
      subtitle={`Ahora: ${formatProfile(current)} · cuenta ${currentAccountId()} · se aplica en el siguiente turno`}
      onCancel={onCancel}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        <Select
          options={options}
          defaultValue={presetOf(current)?.name}
          defaultFocusValue={presetOf(current)?.name ?? 'full'}
          onChange={v => onPick(CONTEXT_PRESETS.find(x => x.name === v)!.profile)}
          onCancel={onCancel}
          hideIndexes
        />
        <Text dimColor>Combinaciones sueltas: /scope mcp:folder skill:user tools:simple · Ctrl+Tab rota los presets</Text>
      </Box>
    </Dialog>
  )
}

async function allEstimates(state: AppState): Promise<Map<string, ContextEstimate>> {
  const out = new Map<string, ContextEstimate>()
  for (const x of CONTEXT_PRESETS) out.set(x.name, await estimateContextProfile(state, x.profile))
  return out
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = args.trim()
  if (trimmed === 'help' || trimmed === '-h' || trimmed === '--help') {
    onDone(HELP, { display: 'system' })
    return null
  }
  const current = context.getAppState().contextProfile ?? FULL_PROFILE
  const set = (p: ContextProfile) => {
    applyContextProfile(context.setAppState, p)
    void estimateContextProfile(context.getAppState(), p).then(est =>
      onDone(`Perfil de contexto: ${presetOf(p) ? `${presetOf(p)!.label} — ` : ''}${describe(p, est)}. Se aplica desde el siguiente turno.`, { display: 'system' }),
    )
  }
  const parsed = parseScopeArgs(trimmed, current)
  if (parsed.kind === 'error') {
    onDone(`${parsed.message}\n\n${HELP}`, { display: 'system' })
    return null
  }
  if (parsed.kind === 'set') {
    set(parsed.profile)
    return null
  }
  const estimates = await allEstimates(context.getAppState())
  return (
    <ScopePicker
      current={current}
      estimates={estimates}
      onPick={set}
      onCancel={() => onDone(`Perfil de contexto sin cambios: ${formatProfile(current)}`, { display: 'system' })}
    />
  )
}
