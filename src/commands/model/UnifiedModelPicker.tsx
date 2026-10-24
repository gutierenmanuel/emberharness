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
 * /model across every connected account: one header per account (like the
 * /account picker), its models below, and a filter you type into. Picking a
 * model of another account switches the session to that account and model.
 */
export function UnifiedModelPicker({ groups, current, onPick, onCancel }: Props): React.ReactNode {
  const [query, setQuery] = React.useState('')

  useInput((input, key) => {
    if (key.backspace || key.delete) setQuery(q => q.slice(0, -1))
    else if (input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !/[\x00-\x1f]/.test(input)) {
      setQuery(q => q + input)
    }
  })

  const options = React.useMemo(() => buildModelPickerOptions(groups, query, current), [groups, query, current])
  const currentValue = `${current.account}:${current.model ?? 'default'}`
  const hasCurrent = options.some(o => o.value === currentValue)
  const firstModel = options.find(o => !o.disabled)?.value
  const total = groups.reduce((n, g) => n + g.models.length, 0)

  return (
    <Dialog
      title="Modelo"
      subtitle={`${total} modelos en ${groups.length} ${groups.length === 1 ? 'cuenta conectada' : 'cuentas conectadas'} · elegir uno de otra cuenta cambia la sesión a esa cuenta`}
      onCancel={query ? () => setQuery('') : onCancel}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text dimColor>Filtro: </Text>
          {query || <Text dimColor>(escribe para buscar por cuenta o modelo)</Text>}
        </Text>
        <Select
          key={query}
          options={options}
          defaultValue={!query && hasCurrent ? currentValue : undefined}
          defaultFocusValue={!query && hasCurrent ? currentValue : firstModel}
          onChange={value => {
            const picked = decodePickerValue(value)
            if (picked) onPick(picked.account, picked.model)
          }}
          onCancel={query ? () => setQuery('') : onCancel}
          visibleOptionCount={14}
          hideIndexes
          disableSelection="numeric"
        />
        <Text dimColor>● en uso · también /model cuenta:modelo · el esfuerzo se ajusta con /effort</Text>
      </Box>
    </Dialog>
  )
}
