import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { formatTokenEstimate } from '../../utils/contextProfile.js'
import { parsePerfilArgs } from '../../utils/perfil.js'
import { estimatePerfil, type PerfilEstimate } from '../../utils/perfilEstimate.js'
import { buildRestartArgs, launcherCanRestart, manualRestartCommand, requestRestart } from '../../utils/perfilRestart.js'
import { listPerfiles, perfilesDir, type PerfilEntry } from '../../utils/perfilStore.js'
import { activeAccountId, switchAccountWithHooks } from '../account/actions.js'
import { applyPerfil, createPerfilFromSession, describePerfil } from './actions.js'

const HELP = [
  '/perfil                 selector de perfiles con descripción y coste en tokens',
  '/perfil <nombre>        aplica el perfil (en caliente, salvo bare o hooks apagados → encendidos: reinicia)',
  '/perfil nuevo <nombre>  guarda lo que tiene la sesión ahora como perfil nuevo y muestra su ruta',
  'Un perfil agrupa system prompt, herramientas y contexto (CLAUDE.md, memoria, hooks, MCP, skills).',
  `Los tuyos viven en ${perfilesDir()}/<nombre>.json; los de fábrica son full, simple, minimo y chat.`,
  'Al arrancar: fnharness --perfil <nombre> (o FNHARNESS_PROFILE). /scope y Ctrl+Tab ajustan el scope encima y marcan el perfil como modificado (nombre*).',
].join('\n')

type PickerProps = {
  entries: PerfilEntry[]
  current: AppState['perfil']
  estimates: Map<string, PerfilEstimate>
  onPick: (name: string) => void
  onCancel: () => void
}

function PerfilPicker({ entries, current, estimates, onPick, onCancel }: PickerProps): React.ReactNode {
  const options = entries.map(e => {
    const est = estimates.get(e.perfil.name)
    const cost = est ? ` · ${formatTokenEstimate(est.total)} (sistema ${est.system}, ${est.toolCount} tools ${est.tools}, skills ${est.skills}${est.claudeMd ? `, CLAUDE.md ${est.claudeMd}` : ''})` : ''
    return {
      value: e.perfil.name,
      label: `${current?.name === e.perfil.name ? '●' : ' '} ${e.perfil.name}${e.source === 'usuario' ? ' (tuyo)' : ''}`,
      description: `${e.perfil.description ? `${e.perfil.description} — ` : ''}${describePerfil(e.perfil)}${cost}`,
    }
  })
  const subtitle = current ? `Ahora: ${current.name}${current.modified ? '*' : ''}` : 'Ahora: ninguno (scope de la cuenta)'
  return (
    <Dialog title="Perfil de contexto" subtitle={`${subtitle} · estimación aproximada`} onCancel={onCancel} color="permission">
      <Box flexDirection="column" gap={1}>
        <Select
          options={options}
          defaultValue={current?.name}
          defaultFocusValue={current?.name ?? entries[0]?.perfil.name}
          onChange={onPick}
          onCancel={onCancel}
          hideIndexes
        />
        <Text dimColor>/perfil nuevo &lt;nombre&gt; guarda la sesión actual como perfil · /perfil help</Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const parsed = parsePerfilArgs(args)
  if (parsed.kind === 'help') {
    onDone(HELP, { display: 'system' })
    return null
  }
  if (parsed.kind === 'error') {
    onDone(`${parsed.message}\n\n${HELP}`, { display: 'system' })
    return null
  }
  if (parsed.kind === 'new') {
    const r = createPerfilFromSession(parsed.name, context.getAppState())
    onDone(r.message, { display: 'system' })
    return null
  }

  const use = async (name: string) => {
    const r = await applyPerfil(name, {
      setAppState: context.setAppState,
      getAppState: context.getAppState,
      switchAccount: (id, model) => switchAccountWithHooks(id, model),
    })
    if (r.kind !== 'restart') {
      onDone(r.message, { display: 'system' })
      return
    }
    const state = context.getAppState()
    const account = r.perfil.account ?? activeAccountId()
    const restartArgs = buildRestartArgs({
      sessionId: getSessionId(),
      perfil: r.perfil.name,
      account,
      model: r.perfil.account ? r.perfil.model : (state.mainLoopModel ?? undefined),
    })
    if (!launcherCanRestart()) {
      onDone(`${r.message} No hay lanzador que relance: sal y ejecuta\n  ${manualRestartCommand(restartArgs)}`, { display: 'system' })
      return
    }
    onDone(`${r.message} Reiniciando…`, { display: 'system' })
    await requestRestart(restartArgs)
  }

  if (parsed.kind === 'use') {
    await use(parsed.name)
    return null
  }

  // Sin argumentos: selector con la estimación de cada perfil.
  const { entries, problems } = listPerfiles()
  const state = context.getAppState()
  const estimates = new Map<string, PerfilEstimate>()
  for (const e of entries) estimates.set(e.perfil.name, await estimatePerfil(state, e.perfil))
  if (problems.length > 0) {
    // Se avisa en el chat; el selector sigue con los perfiles válidos.
    context.addNotification?.({ key: 'perfil-problems', text: `Perfiles con error: ${problems.join(' · ')}`, priority: 'low' })
  }
  return (
    <PerfilPicker
      entries={entries}
      current={state.perfil}
      estimates={estimates}
      onPick={name => void use(name)}
      onCancel={() => onDone(`Perfil sin cambios${state.perfil ? `: ${state.perfil.name}${state.perfil.modified ? '*' : ''}` : ''}`, { display: 'system' })}
    />
  )
}
