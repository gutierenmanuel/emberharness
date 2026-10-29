import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  buildModelPickerOptions,
  decodePickerValue,
  type AccountModelGroup,
} from '../../utils/model/routedModels.js'

type Props = {
  groups: AccountModelGroup[]
  current: { account: string; model: string | null }
  onPick: (account: string, model: string) => void
  onCancel: () => void
}

/**
 * Typing box. It is its own component, rendered before the Select, so its
 * input listener is registered first: the Select's vim keys (j/k) swallow the
 * event otherwise and those letters never reach the filter.
 */
function FilterInput({ query, setQuery, onExit }: { query: string; setQuery: React.Dispatch<React.SetStateAction<string>>; onExit: () => void }): React.ReactNode {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onExit()
    else if (key.backspace || key.delete) setQuery(q => q.slice(0, -1))
    else if (input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !/[\x00-\x1f]/.test(input)) {
      setQuery(q => q + input)
    }
  })
  return (
    <Text>
      <Text dimColor>Filtro: </Text>
      {query || <Text dimColor>(escribe para buscar por cuenta o modelo)</Text>}
    </Text>
  )
}

/**
 * /model across every connected account: one header per account (like the
 * /account picker), its models below, and a filter you type into. Picking a
 * model of another account switches the session to that account and model.
 */
export function UnifiedModelPicker({ groups, current, onPick, onCancel }: Props): React.ReactNode {
  const [query, setQuery] = React.useState('')
  const [focused, setFocused] = React.useState<string | undefined>(undefined)

  const options = React.useMemo(() => buildModelPickerOptions(groups, query, current), [groups, query, current])
  const rows = React.useMemo(
    () =>
      options.map(({ info, ...o }) =>
        info ? { ...o, label: <Text>{o.label}  <Text dimColor>{info}</Text></Text> } : o,
      ),
    [options],
  )
  const currentValue = `${current.account}:${current.model ?? 'default'}`
  const hasCurrent = options.some(o => o.value === currentValue)
  const firstModel = options.find(o => !o.disabled)?.value
  const total = groups.reduce((n, g) => n + g.models.length, 0)
  const initialFocus = !query && hasCurrent ? currentValue : firstModel
  // The focus the Select reports may predate the last filter: fall back to its initial one.
  const focusValue = focused && options.some(o => o.value === focused) ? focused : initialFocus
  const focusedAccount = focusValue ? decodePickerValue(focusValue)?.account : undefined
  const focusedGroup = groups.find(g => g.accountId === focusedAccount)
  const cancel = query ? () => setQuery('') : onCancel

  return (
    <Dialog
      title="Modelo"
      subtitle={`${total} modelos en ${groups.length} ${groups.length === 1 ? 'cuenta conectada' : 'cuentas conectadas'} · elegir uno de otra cuenta cambia la sesión a esa cuenta`}
      onCancel={cancel}
      // The Dialog's own `n` = cancel would eat the letter while filtering; Esc and Ctrl+C are handled here.
      isCancelActive={false}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        <FilterInput query={query} setQuery={setQuery} onExit={onCancel} />
        <Box flexDirection="column">
          <Text bold color="permission">
            {focusedGroup
              ? `Cuenta: ${focusedGroup.label} (${focusedGroup.accountId})${focusedGroup.active ? ' · activa' : ''}`
              : 'Cuenta: —'}
          </Text>
          <Select
            key={query}
            options={rows}
            defaultValue={!query && hasCurrent ? currentValue : undefined}
            defaultFocusValue={initialFocus}
            onFocus={setFocused}
            onChange={value => {
              const picked = decodePickerValue(value)
              if (picked) onPick(picked.account, picked.model)
            }}
            onCancel={cancel}
            visibleOptionCount={14}
            hideIndexes
            disableSelection="numeric"
          />
        </Box>
        <Text dimColor>● en uso · también /model cuenta:modelo · el esfuerzo se ajusta con /effort</Text>
      </Box>
    </Dialog>
  )
}
