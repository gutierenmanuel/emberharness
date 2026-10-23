import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { MultimodelConfigError } from '../../services/api/openai-compat/profiles.js'
import {
  accountsWithStatus,
  activeAccountId,
  addAccount,
  formatAccountLine,
  removeAccount,
  setKey,
  switchAccount,
  type ActionResult,
} from './actions.js'

const HELP = [
  '/account                      selector interactivo',
  '/account list                 cuentas y su estado',
  '/account <id> [modelo]        cambiar de cuenta (y modelo)',
  '/account key <id> <apikey>    guardar la clave de una cuenta',
  '/account add <id> <baseUrl> [modelo]   cuenta OpenAI-compatible propia',
  '/account remove <id>          borrar los datos guardados de una cuenta',
].join('\n')

function AccountPicker({
  options,
  onSelect,
  onCancel,
  initial,
}: {
  options: Array<{ label: string; value: string; description: string }>
  onSelect: (id: string) => void
  onCancel: () => void
  initial: string
}): React.ReactNode {
  return (
    <Dialog title="Cuenta / backend" subtitle="Elige con ↑↓ y Enter" onCancel={onCancel} color="permission">
      <Box flexDirection="column" gap={1}>
        <Select options={options} defaultValue={initial} onChange={onSelect} onCancel={onCancel} visibleOptionCount={12} />
        <Text dimColor>✓ listo · ✗ falta configuración · ○ servidor local apagado</Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean)

  const apply = (run: () => ActionResult) => {
    try {
      const result = run()
      if (result.model !== undefined) {
        context.setAppState(prev => ({
          ...prev,
          mainLoopModel: result.model ?? null,
          mainLoopModelForSession: null,
        }))
      }
      onDone(result.message, { display: 'system' })
    } catch (err) {
      const msg = err instanceof MultimodelConfigError || err instanceof Error ? err.message : String(err)
      onDone(msg, { display: 'system' })
    }
    return null
  }

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    onDone(HELP, { display: 'system' })
    return null
  }
  if (cmd === 'list') {
    const active = activeAccountId()
    const lines = (await accountsWithStatus()).map(a => formatAccountLine(a, active))
    onDone(lines.join('\n'), { display: 'system' })
    return null
  }
  if (cmd === 'key' && rest.length >= 2) return apply(() => setKey(rest[0]!, rest[1]!))
  if (cmd === 'add' && rest.length >= 2) return apply(() => addAccount(rest[0]!, rest[1]!, rest[2]))
  if (cmd === 'remove' && rest.length >= 1) return apply(() => removeAccount(rest[0]!))
  if (cmd) return apply(() => switchAccount(cmd, rest[0]))

  const active = activeAccountId()
  const accounts = await accountsWithStatus()
  const options = accounts.map(a => ({
    value: a.id,
    label: `${a.id === active ? '●' : ' '} ${a.id.padEnd(11)} ${!a.ready ? '✗' : a.online === false ? '○ apagado' : '✓'}`,
    description: a.ready ? `${a.label} — ${a.detail}` : `${a.label} — falta clave: /account key ${a.id} <apikey>`,
  }))
  return (
    <AccountPicker
      options={options}
      initial={active}
      onCancel={() => onDone('Cuenta sin cambios', { display: 'system' })}
      onSelect={id => void apply(() => switchAccount(id, undefined))}
    />
  )
}
