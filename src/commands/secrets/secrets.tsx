import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { BACKENDS, defaultCtx } from '../../services/secrets/secrets.js'
import {
  backendLines,
  formatRow,
  moveSecret,
  removeSecret,
  secretRows,
  setSecret,
  testSecret,
  useSecret,
  type ActionResult,
  type SecretRow,
} from './actions.js'

const HELP = [
  '/secrets                                  gestor interactivo de claves',
  '/secrets list                             cuentas, dónde vive su clave y si se lee',
  '/secrets backends                         gestores disponibles y formato de la referencia',
  '/secrets set <cuenta> <gestor> [ref]      guardar una clave nueva (te la pido oculta; no va por argumento)',
  '/secrets use <cuenta> <gestor:ref>        apuntar a un secreto que ya existe (p. ej. pass:apis/venice)',
  '/secrets move <cuenta> <gestor> [ref]     mover la clave a otro gestor y borrar la copia anterior',
  '/secrets test <cuenta>                    leer la clave y probarla contra el servidor del proveedor',
  '/secrets rm <cuenta> [--purge]            desvincular la clave (--purge borra también el valor del gestor)',
  '',
  'Precedencia al arrancar: variable del proveedor exportada (VENICE_API_KEY) > gestor de la cuenta.',
  'Una clave en claro de accounts.json (de /account key) aún gana a ambas: muévela con /secrets move.',
].join('\n')

type Step =
  | { name: 'list' }
  | { name: 'actions'; row: SecretRow }
  | { name: 'backend'; row: SecretRow; mode: 'set' | 'move' }
  | { name: 'value'; row: SecretRow; backendId: string }
  | { name: 'ref'; row: SecretRow }

type Handlers = {
  onRun: (run: () => ActionResult | Promise<ActionResult>) => void
  onCancel: () => void
}

function stateMark(r: SecretRow): string {
  return r.state === 'ok' ? '✓' : r.state === 'unavailable' ? '!' : '✗'
}

function MaskedPrompt(props: { title: string; subtitle: string; hint: string; onSubmit: (v: string) => void; onBack: () => void }) {
  const { columns } = useTerminalSize()
  const [value, setValue] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  return (
    <Dialog title={props.title} subtitle={props.subtitle} onCancel={props.onBack} color="permission">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{props.hint}</Text>
        <Box flexDirection="row" gap={1}>
          <Text>Clave:</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={v => (v.trim() ? props.onSubmit(v.trim()) : props.onBack())}
            focus={true}
            showCursor={true}
            mask="*"
            columns={Math.max(20, columns - 20)}
            cursorOffset={cursor}
            onChangeCursorOffset={setCursor}
          />
        </Box>
      </Box>
    </Dialog>
  )
}

function RefPrompt(props: { title: string; hint: string; onSubmit: (v: string) => void; onBack: () => void }) {
  const { columns } = useTerminalSize()
  const [value, setValue] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  return (
    <Dialog title={props.title} subtitle="Escribe gestor:ref y pulsa Enter (vacío = volver)" onCancel={props.onBack} color="permission">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{props.hint}</Text>
        <Box flexDirection="row" gap={1}>
          <Text>Ref:</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={v => (v.trim() ? props.onSubmit(v.trim()) : props.onBack())}
            focus={true}
            showCursor={true}
            columns={Math.max(20, columns - 20)}
            cursorOffset={cursor}
            onChangeCursorOffset={setCursor}
          />
        </Box>
      </Box>
    </Dialog>
  )
}

function SecretsManager(props: { rows: SecretRow[] } & Handlers) {
  const { rows, onRun, onCancel } = props
  const [step, setStep] = React.useState<Step>({ name: 'list' })
  const toList = () => setStep({ name: 'list' })

  if (step.name === 'list') {
    const options = rows.map(r => ({
      value: r.id,
      label: `${stateMark(r)} ${r.id.padEnd(14)} ${(r.source === 'env' ? `env:${r.envName}` : r.source === 'legacy' ? 'accounts.json (en claro)' : (r.ref ?? 'sin clave')).padEnd(28)}`,
      description: `${r.label} — ${r.detail || 'ok'}`,
    }))
    return (
      <Dialog title="Secretos" subtitle="↑↓ y Enter para gestionar la clave de una cuenta" onCancel={onCancel} color="permission">
        <Box flexDirection="column" gap={1}>
          <Select
            options={options}
            onChange={id => setStep({ name: 'actions', row: rows.find(r => r.id === id)! })}
            onCancel={onCancel}
            visibleOptionCount={14}
            hideIndexes
            disableSelection="numeric"
          />
          <Text dimColor>✓ se lee · ✗ falta o no existe · ! gestor no instalado. Las claves nunca se muestran.</Text>
        </Box>
      </Dialog>
    )
  }

  if (step.name === 'actions') {
    const { row } = step
    const hasKey = row.source === 'legacy' || row.source === 'ref'
    const options = [
      { value: 'set', label: 'Guardar una clave nueva…', description: 'La pegas (oculta) y eliges en qué gestor queda' },
      { value: 'use', label: 'Usar un secreto que ya existe…', description: 'Por ejemplo pass:apis/venice; se comprueba que se lee' },
      ...(hasKey ? [{ value: 'move', label: 'Mover a otro gestor…', description: 'Copia la clave y borra la anterior si el gestor lo permite' }] : []),
      { value: 'test', label: 'Probar', description: 'Lee la clave y la prueba contra el servidor del proveedor (no se muestra)' },
      ...(hasKey ? [
        { value: 'rm', label: 'Desvincular', description: 'La cuenta deja de usar esta referencia; el valor del gestor no se toca' },
        { value: 'purge', label: 'Desvincular y borrar el valor', description: 'Además borra el secreto del gestor (irreversible)' },
      ] : []),
      { value: 'back', label: 'Volver', description: '' },
    ]
    return (
      <Dialog title={`Clave de ${row.id}`} subtitle={formatRow(row)} onCancel={toList} color="permission">
        <Select
          options={options}
          onChange={v => {
            if (v === 'back') return toList()
            if (v === 'set' || v === 'move') return setStep({ name: 'backend', row, mode: v })
            if (v === 'use') return setStep({ name: 'ref', row })
            if (v === 'test') return onRun(() => testSecret(row.id))
            return onRun(() => removeSecret(row.id, v === 'purge'))
          }}
          onCancel={toList}
          hideIndexes
          disableSelection="numeric"
        />
      </Dialog>
    )
  }

  if (step.name === 'backend') {
    const { row, mode } = step
    const ctx = defaultCtx()
    const writable = Object.values(BACKENDS).filter(b => b.writable)
    const options = writable.map(b => {
      const a = b.available(ctx)
      return {
        value: b.id,
        label: `${a.ok ? ' ' : '✗'} ${b.id.padEnd(8)} ${b.label}`,
        description: a.ok ? `${b.refHelp} — por defecto ${b.id}:${b.defaultRef(row.id)}` : a.hint,
        disabled: !a.ok,
      }
    })
    return (
      <Dialog title={mode === 'set' ? `Dónde guardar la clave de ${row.id}` : `Mover la clave de ${row.id} a…`} subtitle="Enter para elegir gestor" onCancel={() => setStep({ name: 'actions', row })} color="permission">
        <Select
          options={options}
          onChange={backendId => (mode === 'move' ? onRun(() => moveSecret(row.id, backendId, undefined)) : setStep({ name: 'value', row, backendId }))}
          onCancel={() => setStep({ name: 'actions', row })}
          hideIndexes
          disableSelection="numeric"
        />
      </Dialog>
    )
  }

  if (step.name === 'value') {
    const { row, backendId } = step
    return (
      <MaskedPrompt
        title={`Clave de ${row.id}`}
        subtitle={`Se guardará en ${backendId}:${BACKENDS[backendId]!.defaultRef(row.id)}`}
        hint="Pega la API key y pulsa Enter (vacío = cancelar)."
        onSubmit={v => onRun(() => setSecret(row.id, backendId, v))}
        onBack={() => setStep({ name: 'actions', row })}
      />
    )
  }

  const { row } = step
  return (
    <RefPrompt
      title={`Secreto existente para ${row.id}`}
      hint={Object.values(BACKENDS).map(b => `${b.id}: ${b.refHelp}`).join('\n')}
      onSubmit={ref => onRun(() => useSecret(row.id, ref))}
      onBack={() => setStep({ name: 'actions', row })}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const done = (message: string) => void onDone(message, { display: 'system' })

  const apply = async (run: () => ActionResult | Promise<ActionResult>) => {
    try {
      done((await run()).message)
    } catch (err) {
      done(err instanceof Error ? err.message : String(err))
    }
    return null
  }

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    done(HELP)
    return null
  }
  if (cmd === 'list') {
    done(secretRows().map(formatRow).join('\n') || 'Ninguna cuenta necesita clave.')
    return null
  }
  if (cmd === 'backends') {
    done(backendLines().join('\n'))
    return null
  }
  if (cmd === 'test' && rest[0]) return apply(() => testSecret(rest[0]!))
  if (cmd === 'use' && rest.length >= 2) return apply(() => useSecret(rest[0]!, rest[1]!))
  if (cmd === 'move' && rest.length >= 2) return apply(() => moveSecret(rest[0]!, rest[1]!, rest[2]))
  if (cmd === 'rm' && rest[0]) return apply(() => removeSecret(rest[0]!, rest.includes('--purge')))
  if (cmd === 'set' && rest.length >= 2) {
    // The key is never a command argument (it would land in the transcript and history): ask for it masked.
    const [id, backendId, ref] = rest as [string, string, string | undefined]
    if (!BACKENDS[backendId]) return apply(() => { throw new Error(`Gestor desconocido "${backendId}". Mira /secrets backends.`) })
    const row = secretRows().find(r => r.id === id) ?? ({ id, label: id, source: 'none', state: 'missing', detail: '' } as SecretRow)
    return (
      <MaskedPrompt
        title={`Clave de ${id}`}
        subtitle={`Se guardará en ${backendId}:${ref ?? BACKENDS[backendId]!.defaultRef(id)}`}
        hint="Pega la API key y pulsa Enter (vacío = cancelar)."
        onSubmit={v => void apply(() => setSecret(row.id, backendId, v, ref))}
        onBack={() => done('Sin cambios')}
      />
    )
  }
  if (cmd) {
    done(`Subcomando desconocido "${cmd}".\n\n${HELP}`)
    return null
  }

  return <SecretsManager rows={secretRows()} onRun={run => void apply(run)} onCancel={() => done('Secretos sin cambios')} />
}
