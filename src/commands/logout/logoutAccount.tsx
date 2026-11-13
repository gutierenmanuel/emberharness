import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { logoutAnthropicAccount, readAccountInfo } from '../../services/accounts/anthropicAccounts.js'
import { accountsFilePath, isAnthropicAccount, loadStore } from '../../services/api/openai-compat/accounts.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

/**
 * `/logout <id> [--yes]`: closes one Claude account added with
 * `/account add claude` or `/account import`, deleting only
 * `<config>/accounts/<id>/` (after a confirmation). The root login (`claude`)
 * and every other account are left as they are.
 */
export async function callLogoutAccount(onDone: LocalJSXCommandOnDone, args: string): Promise<React.ReactNode> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const yes = parts.includes('--yes') || parts.includes('-y')
  const id = parts.find(p => !p.startsWith('-'))
  if (!id) {
    onDone('Uso: /logout <id> [--yes]   (sin id cierra la cuenta «claude», como siempre)', { display: 'system' })
    return null
  }
  const run = () => {
    try {
      logoutAnthropicAccount(id)
      onDone(`Cuenta Claude ${id} cerrada: borrada accounts/${id}/ y su entrada en accounts.json. Las demás cuentas siguen igual.`, { display: 'system' })
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err), { display: 'system' })
    }
  }
  if (!isAnthropicAccount(id, loadStore(accountsFilePath())) || id === 'claude') {
    run() // reports why it cannot
    return null
  }
  if (yes) {
    run()
    return null
  }
  if (getIsNonInteractiveSession()) {
    onDone(`Para cerrar ${id} sin preguntar: /logout ${id} --yes`, { display: 'system' })
    return null
  }
  const email = readAccountInfo(id)?.emailAddress
  return (
    <Dialog title={`Cerrar la cuenta ${id}`} subtitle="Se borran su login y sus ajustes de accounts/; no se puede deshacer" onCancel={() => onDone('Nada cerrado.', { display: 'system' })} color="warning">
      <Box flexDirection="column" gap={1}>
        <Text>
          {email ? `${id} · ${email}` : id}
        </Text>
        <Select
          options={[
            { value: 'no', label: 'No, dejarla' },
            { value: 'yes', label: `Sí, cerrar ${id}` },
          ]}
          onChange={v => (v === 'yes' ? run() : onDone('Nada cerrado.', { display: 'system' }))}
          onCancel={() => onDone('Nada cerrado.', { display: 'system' })}
        />
      </Box>
    </Dialog>
  )
}
