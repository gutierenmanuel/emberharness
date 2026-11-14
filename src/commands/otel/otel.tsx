import * as React from 'react'
import { readFileSync } from 'fs'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall, LocalJSXCommandContext } from '../../types/command.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { claudeAccountIds, testSink, userSinksPath, type SinkInfo } from '../../utils/telemetry/sinkRuntime.js'
import { readStoreView } from '../../services/accounts/sessionAccounts.js'
import {
  setSinkAccountsInText,
  setSinkEnabledInText,
  setSinkFlagsInText,
  setSinkSignalsInText,
} from '../../utils/telemetry/sinks.js'
import { buildOtelReport, formatOtelReport } from '../../utils/telemetry/otelReport.js'
import { collectOtelReportInput, writeUserSinks as writeUserSinksText } from './otelText.js'

type Action = 'toggle' | 'accounts' | 'prompts' | 'toolDetails' | 'metrics' | 'logs' | 'test' | 'report'

function statusLine(s: SinkInfo): string {
  if (!s.enabled) return `desactivado${s.disabledReason ? `: ${s.disabledReason}` : ''}`
  const parts = [s.activeForSession ? 'recibe esta sesión' : 'ligado, no recibe esta sesión']
  if (s.status?.lastError) parts.push(`error: ${s.status.lastError}`)
  else if (s.status?.lastOkAt) parts.push('enviando')
  return parts.join(' · ')
}

function accountsLabel(accounts: string[]): string {
  return accounts.includes('(todas)') ? '* (todas)' : accounts.join(', ')
}

/** Live state of the picker, re-read on every refresh. */
function readInfos(): SinkInfo[] {
  return buildOtelReport(collectOtelReportInput()).sinksBlock.sinks
}

function knownAccountIds(): string[] {
  return [...new Set([...claudeAccountIds(), ...Object.keys(readStoreView().accounts)])]
}

// ── views ───────────────────────────────────────────────────────────────

type SinkPickerProps = {
  infos: SinkInfo[]
  sessionAccount: string
  path: string
  onOpen: (id: string) => void
  onExit: (message?: string) => void
}

function SinkPicker({ infos, sessionAccount, path, onOpen, onExit }: SinkPickerProps): React.ReactNode {
  const options = infos.map(s => ({
    value: `s:${s.id}`,
    label: `${s.enabled ? (s.activeForSession ? '●' : '○') : '✗'} ${s.id.padEnd(30)} ${s.origin === 'managed' ? '[organización]' : '[propio]'}`,
    description: `${s.endpoint} · ${statusLine(s)} · cuentas: ${accountsLabel(s.accounts)}`,
  }))
  return (
    <Dialog
      title="Telemetría / OpenTelemetry"
      subtitle={`↑↓ receptor, Enter lo gestiona · Esc sale · sesión en la cuenta «${sessionAccount}»`}
      onCancel={() => onExit()}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        {infos.length === 0 ? (
          <Text dimColor>
            No hay receptores declarados. /otel add {'<id> <endpoint> --accounts <a,b>'} · fichero: {path}
          </Text>
        ) : (
          <Select
            options={options}
            onChange={v => onOpen(v.slice(2))}
            onCancel={() => onExit()}
            visibleOptionCount={12}
            hideIndexes
            disableSelection="numeric"
          />
        )}
        <Text dimColor>● recibe esta sesión · ○ ligado, no esta sesión · ✗ desactivado · [organización] = read-only</Text>
        <Text dimColor>DISABLE_TELEMETRY=1 apaga los receptores propios; los de una organización no lo obedecen.</Text>
      </Box>
    </Dialog>
  )
}

type SinkMenuProps = {
  info: SinkInfo
  onBack: () => void
  onAction: (id: string, action: Action) => void
  onTest: (id: string) => void
}

function SinkMenu({ info, onBack, onAction, onTest }: SinkMenuProps): React.ReactNode {
  const managed = info.origin === 'managed'
  const yes = (b: boolean) => (b ? 'sí' : 'no')
  const options = [
    ...(managed
      ? [{ value: 'h:managed', label: '  (receptor de una organización: read-only, se cambia en sus remote settings)', disabled: true }]
      : [
          { value: 'a:toggle', label: `${info.enabled ? '⏻  Desactivar' : '⏻  Activar'} el receptor`, description: info.enabled ? 'Deja de enviarle nada' : 'Vuelve a enviarle telemetría' },
          { value: 'a:accounts', label: 'Cuentas ligadas…', description: `Ahora: ${accountsLabel(info.accounts)}` },
          { value: 'a:prompts', label: `${info.prompts ? '[x]' : '[ ]'} Enviar texto de prompts`, description: info.prompts ? 'Ahora sí; al quitarlo se envía <REDACTED>' : 'Ahora se envía <REDACTED>' },
          { value: 'a:toolDetails', label: `${info.toolDetails ? '[x]' : '[ ]'} Enviar detalle de herramientas`, description: 'Comandos, paths y argumentos de tool calls' },
          { value: 'a:metrics', label: `${info.signals.includes('metrics') ? '[x]' : '[ ]'} Señal de métricas`, description: 'Contadores: sesiones, coste, tokens…' },
          { value: 'a:logs', label: `${info.signals.includes('logs') ? '[x]' : '[ ]'} Señal de logs/eventos`, description: 'Eventos de la sesión' },
        ]),
    { value: 'a:test', label: 'Enviar punto de prueba', description: managed ? 'No disponible para receptores de organización' : 'POST directo; muestra el código HTTP' },
    { value: 'a:report', label: 'Informe completo (reporte clásico)', description: 'Variables, destinos, estado por receptor' },
  ]
  return (
    <Dialog title={`Receptor ${info.id}`} subtitle={`${info.endpoint} · ${statusLine(info)}`} onCancel={onBack} color="permission">
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          esquema {info.schema} · protocolo {info.protocol} · credenciales: {info.hasCredentials ? 'sí (ocultas)' : 'no'}
        </Text>
        <Select
          options={options}
          onChange={v => {
            const a = v.slice(2) as Action
            if (a === 'test') return onTest(info.id)
            return onAction(info.id, a)
          }}
          onCancel={onBack}
          visibleOptionCount={12}
          hideIndexes
          disableSelection="numeric"
        />
        <Text dimColor>
          prompts: {yes(info.prompts)} · detalle tools: {yes(info.toolDetails)} · métricas: {yes(info.signals.includes('metrics'))} · logs: {yes(info.signals.includes('logs'))}
        </Text>
      </Box>
    </Dialog>
  )
}

type AccountsMenuProps = {
  sinkId: string
  current: string[]
  known: string[]
  onApply: (accounts: '*' | string[]) => void
  onCancel: () => void
}

function AccountsMenu({ sinkId, current, known, onApply, onCancel }: AccountsMenuProps): React.ReactNode {
  const allNow = current.includes('(todas)')
  const [working, setWorking] = React.useState<string[]>(allNow ? ['(todas)'] : [...current])
  const toggle = (id: string) => {
    if (id === '*') return onApply('*')
    setWorking(w => (w.includes('(todas)') ? [id] : w.includes(id) ? w.filter(x => x !== id) : [...w, id]))
  }
  const options = [
    { value: 'acc:*', label: `${working.includes('(todas)') ? '●' : ' '} * (todas las cuentas)`, description: 'Con cuentas corporativas mejor lista explícita' },
    ...known.map(a => ({
      value: `acc:${a}`,
      label: `${working.includes(a) ? '●' : ' '} ${a}`,
      description: working.includes(a) ? 'Enter para desligar' : 'Enter para ligar',
    })),
  ]
  return (
    <Dialog
      title={`Cuentas ligadas de ${sinkId}`}
      subtitle="Enter alterna una cuenta · Esc cancela · Guardar aplica"
      onCancel={onCancel}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        <Select
          options={options}
          defaultValue={known.length ? `acc:${known[0]}` : 'acc:*'}
          defaultFocusValue={known.length ? `acc:${known[0]}` : 'acc:*'}
          onChange={v => toggle(v.slice(4))}
          onCancel={onCancel}
          visibleOptionCount={12}
          hideIndexes
          disableSelection="numeric"
        />
        <Select
          options={[{ value: 'save', label: 'Guardar selección', description: `Aplicará: ${working.includes('(todas)') ? '*' : working.join(', ') || '(ninguna)'}` }]}
          onChange={() => onApply(working.includes('(todas)') ? '*' : working)}
          hideIndexes
          disableSelection="numeric"
        />
        <Text dimColor>Guardar con ninguna cuenta dejara el receptor sin ligar (parseUserSinks lo rechaza).</Text>
      </Box>
    </Dialog>
  )
}

// ── state machine ───────────────────────────────────────────────────────

type Screen = { kind: 'main' } | { kind: 'sink'; id: string } | { kind: 'accounts'; id: string }

function OtelTui({ onExit, context }: { onExit: (message?: string) => void; context: LocalJSXCommandContext }): React.ReactNode {
  const [tick, setTick] = React.useState(0)
  const [screen, setScreen] = React.useState<Screen>({ kind: 'main' })
  const [message, setMessage] = React.useState<string | null>(null)
  const rerender = () => setTick(t => t + 1)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const infos = React.useMemo(() => readInfos(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const known = React.useMemo(() => knownAccountIds(), [tick])
  const sessionAccount = React.useMemo(() => buildOtelReport(collectOtelReportInput()).account.id, [])
  const reportText = React.useMemo(() => formatOtelReport(buildOtelReport(collectOtelReportInput())), [])

  const apply = (id: string, edit: (text: string | null) => { text: string | null; error: string | null }) => {
    let current: string | null = null
    try {
      current = readFileSync(userSinksPath(), 'utf8')
    } catch {
      current = null
    }
    const r = edit(current)
    if (!r.text) {
      setMessage(`No se guardo: ${r.error}`)
      rerender()
      return
    }
    const { path, backup } = writeUserSinksText(r.text)
    setMessage(`Guardado en ${path}${backup ? ` (copia previa: ${backup})` : ''}`)
    rerender()
  }

  const doAction = (id: string, action: Action) => {
    const info = infos.find(s => s.id === id)
    if (!info) return
    if (action === 'accounts') return setScreen({ kind: 'accounts', id })
    if (action === 'report') return onExit(reportText)
    if (action === 'toggle') return apply(id, text => setSinkEnabledInText(text, id, !info.enabled))
    if (action === 'prompts') return apply(id, text => setSinkFlagsInText(text, id, { logUserPrompts: !info.prompts }))
    if (action === 'toolDetails') return apply(id, text => setSinkFlagsInText(text, id, { logToolDetails: !info.toolDetails }))
    if (action === 'metrics') return apply(id, text => setSinkSignalsInText(text, id, { metrics: !info.signals.includes('metrics') }))
    if (action === 'logs') return apply(id, text => setSinkSignalsInText(text, id, { logs: !info.signals.includes('logs') }))
  }

  const banner = message ? (
    <Box marginBottom={1}>
      <Text dimColor>{message}</Text>
    </Box>
  ) : null

  if (screen.kind === 'accounts') {
    const info = infos.find(s => s.id === screen.id)
    if (!info) return null
    return (
      <AccountsMenu
        sinkId={screen.id}
        current={info.accounts}
        known={known}
        onApply={accounts => {
          apply(screen.id, text => setSinkAccountsInText(text, screen.id, accounts))
          setScreen({ kind: 'sink', id: screen.id })
        }}
        onCancel={() => setScreen({ kind: 'sink', id: screen.id })}
      />
    )
  }

  if (screen.kind === 'sink') {
    const info = infos.find(s => s.id === screen.id)
    if (!info) return null
    return (
      <Box flexDirection="column">
        {banner}
        <SinkMenu
          info={info}
          onBack={() => setScreen({ kind: 'main' })}
          onAction={doAction}
          onTest={id =>
            void testSink(id).then(r => {
              setMessage(`${r.ok ? 'OK' : 'FALLO'}: ${r.detail}`)
              rerender()
            })
          }
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {banner}
      <SinkPicker infos={infos} sessionAccount={sessionAccount} path={userSinksPath()} onOpen={id => setScreen({ kind: 'sink', id })} onExit={msg => onExit(msg ?? message ?? undefined)} />
    </Box>
  )
}

// ── entry ───────────────────────────────────────────────────────────────

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)

  // Textual modes keep working: /otel test <id>, /otel add ..., /otel --json,
  // and any non-interactive session (no picker there).
  const textual = tokens.filter(t => t !== '--json')
  if (getIsNonInteractiveSession() || tokens.includes('--json') || textual[0] === 'test' || textual[0] === 'add') {
    const { call: textCall } = await import('./otelText.js')
    const result = await textCall(args, context)
    onDone(result.value, { display: 'system' })
    return null
  }

  return <OtelTui onExit={msg => onDone(msg ?? 'Telemetría sin cambios', { display: 'system' })} context={context} />
}
