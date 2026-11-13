/**
 * What has to happen when the session moves to a Claude account (from
 * /account <id> or /model <id>:<modelo>): drop every cache keyed on the old
 * identity, make the new account in force and load its organisation's
 * managed settings and policies (dialog included when they bring dangerous
 * settings).
 *
 * Kept apart from commands/account/actions.ts so the pure account actions do
 * not import auth.ts; actions.ts loads this lazily, only on the real process.
 */

import { clearOAuthTokenCache, getOauthAccountInfo } from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { markAccountTouched } from './sessionAccounts.js'
import { refreshAccountManagedSettings } from '../remoteManagedSettings/index.js'

/** Env vars the statusline reads: who the Claude account in force is. */
export function exportAccountIdentityEnv(env: Record<string, string | undefined> = process.env): void {
  const info = getOauthAccountInfo()
  if (info?.emailAddress) env.FNHARNESS_ACCOUNT_EMAIL = info.emailAddress
  else delete env.FNHARNESS_ACCOUNT_EMAIL
}

export async function afterAnthropicSessionSwitch(id: string, previous: string | null): Promise<void> {
  // The account the session leaves was in use: its policies keep applying (D7).
  if (previous) markAccountTouched(previous)
  clearOAuthTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()
  resetUserCache()
  markAccountTouched(id)
  exportAccountIdentityEnv()
  settingsChangeDetector.notifyChange('policySettings')
  await refreshAccountManagedSettings(id)
}
