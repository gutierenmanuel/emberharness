import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { getMultimodelProfile } from '../../services/api/openai-compat/profiles.js'
import { getAccountRemoteSettings, getSettingsPath as getRemoteSettingsPath } from '../../services/remoteManagedSettings/syncCacheState.js'
import { activeAnthropicAccountId } from '../../services/accounts/sessionAccounts.js'
import { telemetryEnvOf } from '../../services/accounts/managedPolicy.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { isTelemetryEnabled } from '../../utils/telemetry/instrumentation.js'
import { humanDisabledTelemetry, invalidateUserSinks, loadUserSinks, sinkInfos, testSink, userSinksPath } from '../../utils/telemetry/sinkRuntime.js'
import { addUserSinkToText, parseAddArgs } from '../../utils/telemetry/sinks.js'
import {
  buildOtelReport,
  formatOtelReport,
  type EnvLayer,
} from '../../utils/telemetry/otelReport.js'

/** What profiles.ts setActiveProfile() sets on a non-Claude account. */
const PROFILE_DEFAULT_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  FNHARNESS_PROFILE_NO_TELEMETRY: '1',
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readRemoteSettingsFileEnv(accountId: string): Record<string, string> | undefined {
  const text = readText(getRemoteSettingsPath(accountId))
  if (text === null) return undefined
  try {
    const env = (JSON.parse(text) as { env?: unknown })?.env
    return env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, string>) : undefined
  } catch {
    return undefined
  }
}

/** Gathers the inputs of the report (the only impure part). */
export function collectOtelReportInput() {
  const profile = getMultimodelProfile()
  const accountId = process.env.FNHARNESS_ACCOUNT ?? 'claude'
  const holder = profile ? undefined : getOauthAccountInfo()

  // Remote settings of the Claude account in force: since there can be
  // several, its telemetry is read from that account's own copy (the merged
  // settings the session runs with no longer carry any OTEL_*).
  const managedFrom = activeAnthropicAccountId()
  const remote = getAccountRemoteSettings(managedFrom)
  const remoteEnv = remote ? telemetryEnvOf(remote as Record<string, unknown>) : undefined
  const hasRemote = !!remoteEnv && Object.keys(remoteEnv).length > 0
  const policyEnv = getSettingsForSource('policySettings')?.env
  // The file can exist without being in force (the account is not eligible
  // or not in use in this session): shown anyway, marked.
  const fileEnv = hasRemote ? undefined : readRemoteSettingsFileEnv(managedFrom)
  const layers: EnvLayer[] = [
    hasRemote
      ? { origin: 'remote-settings', label: `remote-settings de la organización de ${managedFrom} (receptor de esa cuenta)`, env: remoteEnv }
      : fileEnv
        ? { origin: 'remote-settings', label: `remote-settings de la organización de ${managedFrom} (fichero; cuenta no en uso en esta sesión)`, env: fileEnv }
        : { origin: 'managed-settings', label: 'ajustes gestionados (managed-settings)', env: policyEnv },
    ...(
      [
        ['flagSettings', '--settings'],
        ['localSettings', 'settings.local.json'],
        ['projectSettings', 'settings.json del proyecto'],
        ['userSettings', 'settings.json'],
      ] as const
    )
      .filter(([source]) => isSettingSourceEnabled(source))
      .map(([source, label]): EnvLayer => ({ origin: 'settings', label: `${label} (env)`, env: getSettingsForSource(source)?.env })),
    { origin: 'global-config', label: '.claude.json (env)', env: getGlobalConfig().env },
  ]

  const user = loadUserSinks()
  return {
    buildEnabled: isTelemetryEnabled(),
    account: {
      id: accountId,
      label: profile?.label ?? 'Claude',
      provider: profile?.provider ?? null,
      email: holder?.emailAddress ?? null,
      org: holder?.organizationName ?? null,
      managedFrom,
    },
    layers,
    processEnv: process.env,
    profileEnv: profile ? PROFILE_DEFAULT_ENV : {},
    profileLabel: profile ? `perfil de la cuenta ${accountId}` : undefined,
    sinksBlock: {
      path: user.path,
      present: user.present,
      errors: user.errors,
      sinks: sinkInfos(),
      humanDisabled: humanDisabledTelemetry(),
    },
  }
}

/** Writes telemetry.json (0600, atomic), keeping a dated backup of the previous one. */
function writeUserSinks(text: string): { path: string; backup: string | null } {
  const path = userSinksPath()
  mkdirSync(dirname(path), { recursive: true })
  let backup: string | null = null
  if (existsSync(path)) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(path, backup)
    chmodSync(backup, 0o600)
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
  invalidateUserSinks()
  return { path, backup }
}

export const call: LocalCommandCall = async args => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const [sub, ...rest] = tokens
  if (sub === 'test') {
    if (!rest[0]) return { type: 'text', value: 'uso: /telemetry test <id-del-receptor>' }
    const r = await testSink(rest[0])
    return { type: 'text', value: `${r.ok ? 'OK' : 'FALLO'}: ${r.detail}` }
  }
  if (sub === 'add') {
    const { spec, error } = parseAddArgs(rest)
    if (!spec) return { type: 'text', value: error ?? 'argumentos no válidos' }
    const { text, error: err } = addUserSinkToText(readText(userSinksPath()), spec)
    if (!text) return { type: 'text', value: `No se añadió: ${err}` }
    const { path, backup } = writeUserSinks(text)
    return { type: 'text', value: `Receptor "${spec.id}" guardado en ${path}${backup ? ` (copia previa: ${backup})` : ''}. Pruébalo con /telemetry test ${spec.id}.` }
  }
  const report = buildOtelReport(collectOtelReportInput())
  const json = tokens.includes('--json')
  return { type: 'text', value: json ? JSON.stringify(report, null, 2) : formatOtelReport(report) }
}
