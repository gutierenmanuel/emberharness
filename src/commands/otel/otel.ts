import { readFileSync } from 'fs'
import { join } from 'path'
import { getMultimodelProfile } from '../../services/api/openai-compat/profiles.js'
import { getRemoteManagedSettingsSyncFromCache, getSettingsPath as getRemoteSettingsPath } from '../../services/remoteManagedSettings/syncCacheState.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { isTelemetryEnabled } from '../../utils/telemetry/instrumentation.js'
import {
  buildOtelReport,
  formatOtelReport,
  parseOwnSinks,
  type EnvLayer,
} from '../../utils/telemetry/otelReport.js'

/** What profiles.ts setActiveProfile() sets by default on a non-Claude account (`||=`). */
const PROFILE_DEFAULT_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readRemoteSettingsFileEnv(): Record<string, string> | undefined {
  const text = readText(getRemoteSettingsPath())
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

  const remote = getRemoteManagedSettingsSyncFromCache()
  const hasRemote = !!remote && Object.keys(remote).length > 0
  const policyEnv = getSettingsForSource('policySettings')?.env
  // El fichero remote-settings.json puede existir sin aplicarse (la sesión no cumple los requisitos
  // de elegibilidad, p. ej. otra cuenta): se muestra igualmente, marcado, porque es lo que la
  // organización inyectaría en una sesión elegible.
  const fileEnv = hasRemote || policyEnv ? undefined : readRemoteSettingsFileEnv()
  const layers: EnvLayer[] = [
    fileEnv
      ? { origin: 'remote-settings', label: 'remote-settings de la organización (fichero, no aplicado en esta sesión)', env: fileEnv }
      : {
          origin: hasRemote ? 'remote-settings' : 'managed-settings',
          label: hasRemote ? 'remote-settings de la organización' : 'ajustes gestionados (managed-settings)',
          env: policyEnv,
        },
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

  const dir = getClaudeConfigHomeDir()
  const sinksPath = join(dir, 'telemetry.json')
  return {
    buildEnabled: isTelemetryEnabled(),
    account: {
      id: accountId,
      label: profile?.label ?? 'Claude',
      provider: profile?.provider ?? null,
      email: holder?.emailAddress ?? null,
      org: holder?.organizationName ?? null,
    },
    layers,
    processEnv: process.env,
    profileEnv: profile ? PROFILE_DEFAULT_ENV : {},
    profileLabel: profile ? `perfil de la cuenta ${accountId}` : undefined,
    ownSinks: parseOwnSinks(sinksPath, readText(sinksPath)),
  }
}

export const call: LocalCommandCall = async args => {
  const report = buildOtelReport(collectOtelReportInput())
  const json = args.split(/\s+/).includes('--json')
  return { type: 'text', value: json ? JSON.stringify(report, null, 2) : formatOtelReport(report) }
}
