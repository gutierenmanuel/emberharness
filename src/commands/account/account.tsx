import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { loadContextProfileForAccount } from '../../utils/contextProfileStore.js'
import { accountsFilePath, loadStore } from '../../services/api/openai-compat/accounts.js'
import type { Catalog } from '../../services/api/openai-compat/catalog.js'
import { loadCatalog } from '../../services/api/openai-compat/catalogStore.js'
import { MultimodelConfigError } from '../../services/api/openai-compat/profiles.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isAnthropicAccount } from '../../services/api/openai-compat/accounts.js'
import {
  assertNewAccountId,
  readAccountInfo,
  setLoginTargetAccount,
} from '../../services/accounts/anthropicAccounts.js'
import { Login } from '../login/login.js'
import { ManagedSettingsSecurityDialog } from '../../components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.js'
import {
  claudeIdentity,
  collectAccountPanel,
  doctorAction,
  importAction,
  migrateOnce,
  panelText,
} from './anthropicActions.js'
import {
  accountsWithStatus,
  catalogLines,
  activeAccountId,
  addAccount,
  buildPickerSections,
  setDefaultAccount,
  startupSummary,
  presetKeyHint,
  type PickerEntry,
  formatAccountLine,
  removeAccount,
  setKey,
  switchAccountWithHooks,
  type ActionResult,
} from './actions.js'

const HELP = [
  '/account                      selector interactivo',
  '/account list                 cuentas y su estado',
  '/account <id> [modelo]        cambiar de cuenta (y modelo)',
  '/account default <id|last> [modelo]   cuenta (y modelo) con la que abre emberh; last = la última usada',
  '/account key <id> <apikey>    guardar la clave de una cuenta',
  '/account add <id> <baseUrl> [modelo]   cuenta OpenAI-compatible propia',
  '/account add <proveedor> [id] [modelo] cuenta de un proveedor del catálogo (sin URL)',
  '/account catalog [texto]      proveedores del catálogo models.dev con su nº de modelos',
  '/account remove <id>          borrar los datos guardados de una cuenta',
  '/account add claude <id>      cuenta Claude (OAuth) más: abre el login y la guarda en accounts/<id>/',
  '/account import <dir> --as <id>   copiar el login Claude de otro directorio (p. ej. ~/.fnharness-work)',
  '/account doctor [--fix]       permisos de credenciales (0600) y carpetas de cuenta (0700)',
  '/account approve <id>         revisar los ajustes gestionados nuevos de una cuenta Claude (aceptar o rechazar)',
  '/logout <id>                  cerrar una cuenta Claude añadida (borra solo accounts/<id>/)',
].join('\n')

type PickerProps = {
  active: string
  accounts: Awaited<ReturnType<typeof accountsWithStatus>>
  catalog: Catalog
  stored: Record<string, unknown>
  onSwitch: (id: string) => void
  onAdd: (provider: string) => string | null
  onAddCustom: (spec: string) => void
  onRemove: (id: string) => void
  removable: string[]
  onSaveKey: (id: string, key: string, prefix?: string) => void
  onCancel: (message?: string) => void
}

function entryOption(e: PickerEntry, active: string) {
  if (e.kind === 'account') {
    const state = !e.ready ? '✗ falta clave' : e.online === false ? '○ apagado' : '✓ listo'
    return {
      value: `a:${e.id}`,
      label: `${e.id === active ? '●' : ' '} ${e.id.padEnd(22)} ${state}`,
      description: e.ready ? `${e.label} — ${e.detail}` : `${e.label} — /account key ${e.id} <apikey>`,
    }
  }
  if (e.kind === 'preset') {
    return {
      value: `p:${e.id}`,
      label: `  ${e.id.padEnd(22)} + integrada`,
      description: `${e.label} — falta clave${e.keyEnv ? ` (${e.keyEnv})` : ''}`,
    }
  }
  return {
    value: `c:${e.id}`,
    label: `  ${e.id.padEnd(22)} + ${String(e.modelCount).padStart(3)} modelos`,
    description: e.label,
  }
}

function AccountPicker(props: PickerProps): React.ReactNode {
  const { active, accounts, catalog, stored, onSwitch, onAdd, onAddCustom, onRemove, removable, onSaveKey, onCancel } = props
  // 'remove' lists the accounts that can be deleted; 'custom' asks `id url [modelo]`.
  const [mode, setMode] = React.useState<'main' | 'remove' | 'custom'>('main')
  const [customValue, setCustomValue] = React.useState('')
  const [customCursor, setCustomCursor] = React.useState(0)
  const [query, setQuery] = React.useState('')
  // Entry whose API key is being typed, once an account to add has been chosen.
  const [keyFor, setKeyFor] = React.useState<{ id: string; hint: string; done?: string } | null>(null)
  const [keyValue, setKeyValue] = React.useState('')
  const [keyCursor, setKeyCursor] = React.useState(0)
  const { columns } = useTerminalSize()

  useInput(
    (input, key) => {
      if (key.backspace || key.delete) setQuery(q => q.slice(0, -1))
      else if (input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && !/[\x00-\x1f]/.test(input)) {
        setQuery(q => q + input)
      }
    },
    { isActive: keyFor === null && mode === 'main' },
  )

  const sections = React.useMemo(() => buildPickerSections(accounts, catalog, query, stored), [accounts, catalog, query, stored])

  if (keyFor) {
    return (
      <Dialog title={`Clave de ${keyFor.id}`} subtitle="Pega la API key y pulsa Enter (vacío = ponerla luego)" onCancel={() => (keyFor.done ? onCancel(keyFor.done) : setKeyFor(null))} color="permission">
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{keyFor.hint}</Text>
          <Box flexDirection="row" gap={1}>
            <Text>Clave:</Text>
            <TextInput
              value={keyValue}
              onChange={setKeyValue}
              onSubmit={v => (v.trim() ? onSaveKey(keyFor.id, v.trim(), keyFor.done) : onCancel(keyFor.done))}
              focus={true}
              showCursor={true}
              mask="*"
              columns={Math.max(20, columns - 20)}
              cursorOffset={keyCursor}
              onChangeCursorOffset={setKeyCursor}
            />
          </Box>
        </Box>
      </Dialog>
    )
  }

  if (mode === 'custom') {
    return (
      <Dialog title="Añadir cuenta propia" subtitle="Escribe: <id> <baseUrl> [modelo] y pulsa Enter" onCancel={() => setMode('main')} color="permission">
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Servidor OpenAI-compatible, p. ej.: miserver http://localhost:9000/v1 llama3</Text>
          <Box flexDirection="row" gap={1}>
            <Text>Cuenta:</Text>
            <TextInput
              value={customValue}
              onChange={setCustomValue}
              onSubmit={v => (v.trim() ? onAddCustom(v.trim()) : setMode('main'))}
              focus={true}
              showCursor={true}
              columns={Math.max(20, columns - 20)}
              cursorOffset={customCursor}
              onChangeCursorOffset={setCustomCursor}
            />
          </Box>
        </Box>
      </Dialog>
    )
  }

  if (mode === 'remove') {
    const opts = removable.length
      ? removable.map(id => ({ value: `r:${id}`, label: `  ${id}`, description: `Borrar los datos guardados de ${id}` }))
      : [{ value: 'h:none', label: '  (no hay cuentas guardadas que quitar)', disabled: true }]
    return (
      <Dialog title="Quitar cuenta" subtitle="Enter borra los datos guardados (clave incluida); Esc vuelve" onCancel={() => setMode('main')} color="permission">
        <Select
          options={opts}
          onChange={v => v.startsWith('r:') && onRemove(v.slice(2))}
          onCancel={() => setMode('main')}
          visibleOptionCount={14}
          hideIndexes
          disableSelection="numeric"
        />
      </Dialog>
    )
  }

  const options = [
    { value: 'h:manage', label: '── Gestionar ──', disabled: true },
    { value: 'm:custom', label: '  + Añadir cuenta con URL propia', description: 'Servidor OpenAI-compatible fuera del catálogo' },
    { value: 'm:remove', label: `  − Quitar cuenta (${removable.length})`, description: 'Borra los datos guardados de una cuenta' },
    { value: 'h:active', label: '── Cuentas activas ──', disabled: true },
    ...sections.active.map(e => entryOption(e, active)),
    { value: 'h:add', label: `── Añadir cuenta (${sections.add.length}) ──`, disabled: true },
    ...sections.add.map(e => entryOption(e, active)),
  ]
  if (sections.add.length === 0) {
    options.push({ value: 'h:none', label: `  (nada coincide con "${query}")`, disabled: true })
  }

  const onChange = (value: string) => {
    const id = value.slice(2)
    if (value === 'm:custom') return setMode('custom')
    if (value === 'm:remove') return setMode('remove')
    if (value.startsWith('a:')) return onSwitch(id)
    if (value.startsWith('p:')) {
      setKeyValue('')
      setKeyCursor(0)
      return setKeyFor({ id, hint: presetKeyHint(id) })
    }
    if (value.startsWith('c:')) {
      const message = onAdd(id)
      if (message === null) return
      setKeyValue('')
      setKeyCursor(0)
      return setKeyFor({ id, hint: message, done: message })
    }
  }

  return (
    <Dialog
      title="Cuenta / backend"
      subtitle="↑↓ para moverte, Enter para elegir, escribe para filtrar «Añadir cuenta»"
      onCancel={query ? () => setQuery('') : () => onCancel()}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text dimColor>Filtro: </Text>
          {query || <Text dimColor>(escribe para buscar proveedores)</Text>}
        </Text>
        <Select
          key={query}
          options={options}
          defaultValue={query ? undefined : `a:${active}`}
          defaultFocusValue={query ? options.find(o => !o.disabled && !o.value.startsWith('a:') && !o.value.startsWith('m:'))?.value : `a:${active}`}
          onChange={onChange}
          onCancel={query ? () => setQuery('') : () => onCancel()}
          visibleOptionCount={14}
          hideIndexes
          disableSelection="numeric"
        />
        <Text dimColor>✓ listo · ✗ falta clave · ○ servidor local apagado · ● activa · + añadir</Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  // First use of /account in this config dir: register the root login as the
  // Claude account `claude` (a copy in accounts/claude/, the root untouched).
  const migrated = migrateOnce()
  const withMigration = (text: string) => (migrated ? `${migrated}\n${text}` : text)
  const sessionModel = () => context.getAppState().mainLoopModel ?? null

  const apply = async (run: () => ActionResult | Promise<ActionResult>) => {
    try {
      const result = await run()
      if (result.model !== undefined) {
        // The account changed: its remembered context profile comes with it.
        const contextProfile = loadContextProfileForAccount(activeAccountId())
        context.setAppState(prev => ({
          ...prev,
          mainLoopModel: result.model ?? null,
          mainLoopModelForSession: null,
          // Con un perfil activo manda su scope, no el que la cuenta recordaba.
          ...(prev.perfil ? {} : { contextProfile }),
        }))
        clearSystemPromptSections()
      }
      onDone(withMigration(result.message), { display: 'system' })
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
  if (cmd === 'list' || (!cmd && getIsNonInteractiveSession())) {
    const panel = panelText({ accounts: await accountsWithStatus(), sessionModel: sessionModel() })
    onDone(withMigration([panel, '', startupSummary()].join('\n')), { display: 'system' })
    return null
  }
  if (cmd === 'import') {
    return apply(() => importAction(rest))
  }
  if (cmd === 'approve' && rest.length >= 1) {
    const id = rest[0]!
    const rms = await import('../../services/remoteManagedSettings/index.js')
    const { accountDialogHeader } = await import('../../services/remoteManagedSettings/securityCheck.js')
    const pending = rms.pendingManagedSettings(id)
    if (!pending) {
      onDone(`La cuenta ${id} no tiene ajustes gestionados pendientes de aprobar.`, { display: 'system' })
      return null
    }
    const finish = (accepted: boolean) => void rms.resolvePendingManagedSettings(id, accepted).then(m => onDone(m, { display: 'system' }))
    return (
      <Box flexDirection="column">
        <Text bold color="warning">{accountDialogHeader(id) ?? `Cuenta ${id}`}</Text>
        <ManagedSettingsSecurityDialog settings={pending} onAccept={() => finish(true)} onReject={() => finish(false)} />
      </Box>
    )
  }
  if (cmd === 'doctor') {
    onDone(withMigration(doctorAction(rest.includes('--fix')).message), { display: 'system' })
    return null
  }
  if (cmd === 'add' && rest[0] === 'claude' && rest.length >= 2) {
    const id = rest[1]!
    try {
      const store = loadStore(accountsFilePath())
      if (id === 'claude') throw new MultimodelConfigError('La cuenta «claude» inicia sesión con /login.')
      // Re-login of an existing Claude account is allowed (expired session).
      if (!isAnthropicAccount(id, store)) assertNewAccountId(id, store)
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err), { display: 'system' })
      return null
    }
    setLoginTargetAccount(id)
    return (
      <Login
        startingMessage={`Inicio de sesión para la cuenta Claude «${id}»: se guarda en accounts/${id}/ y no toca la cuenta «claude».`}
        onDone={(success: boolean) => {
          setLoginTargetAccount(null)
          if (!success) {
            onDone(`Login de ${id} interrumpido; no se ha guardado nada.`, { display: 'system' })
            return
          }
          const info = readAccountInfo(id)
          const who = info ? claudeIdentity({ email: info.emailAddress, org: info.organizationName ?? null, orgUuid: info.organizationUuid ?? null, plan: null }) : 'sin identidad'
          onDone(withMigration(`Cuenta Claude ${id} lista (${who}). Úsala con /account ${id} o en un agente con ${id}:sonnet.`), { display: 'system' })
        }}
      />
    )
  }
  if (cmd === 'catalog') {
    onDone(catalogLines(loadCatalog(), rest.join(' ')).join('\n'), { display: 'system' })
    return null
  }
  if (cmd === 'default' && rest.length >= 1) return apply(() => setDefaultAccount(rest[0]!, rest[1]))
  if (cmd === 'key' && rest.length >= 2) return apply(() => setKey(rest[0]!, rest[1]!))
  if (cmd === 'add' && rest.length >= 1) return apply(() => addAccount(rest[0]!, rest[1], rest[2]))
  if (cmd === 'remove' && rest.length >= 1) return apply(() => removeAccount(rest[0]!))
  if (cmd) return apply(() => switchAccountWithHooks(cmd, rest[0]))

  const active = activeAccountId()
  // Claude accounts show who they are (correo · organización · plan) in the picker.
  const identities = new Map(collectAccountPanel({ sessionModel: sessionModel() }).entries.map(e => [e.id, e]))
  const accounts = (await accountsWithStatus()).map(a => {
    const e = identities.get(a.id)
    if (!e || !isAnthropicAccount(a.id, loadStore(accountsFilePath()))) return a
    const detail = e.state === '✓ lista' ? e.identity : `${e.identity} · ${e.state}${a.id === 'claude' ? ' (/login)' : ` (/account add claude ${a.id})`}`
    return { ...a, detail }
  })
  const catalog = loadCatalog()
  const stored = loadStore(accountsFilePath()).accounts
  return (
    <AccountPicker
      active={active}
      accounts={accounts}
      catalog={catalog}
      stored={stored}
      onCancel={message => void onDone(message ?? 'Cuenta sin cambios', { display: 'system' })}
      onSwitch={id => void apply(() => switchAccountWithHooks(id, undefined))}
      onAdd={provider => {
        try {
          return addAccount(provider, undefined, undefined).message
        } catch (err) {
          apply(() => {
            throw err
          })
          return null
        }
      }}
      removable={Object.keys(stored).filter(id => id !== active)}
      onRemove={id => void apply(() => removeAccount(id))}
      onAddCustom={spec => {
        const [id, url, model] = spec.split(/\s+/)
        void apply(() => {
          if (!id || !url) throw new MultimodelConfigError('Formato: <id> <baseUrl> [modelo]')
          return addAccount(id, url, model)
        })
      }}
      onSaveKey={(id, key, prefix) =>
        void apply(() => {
          const saved = setKey(id, key)
          return { message: prefix ? `${prefix}\n${saved.message}` : saved.message }
        })
      }
    />
  )
}
