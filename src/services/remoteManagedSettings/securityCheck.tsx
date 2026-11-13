import React from 'react';
import { getIsInteractive } from '../../bootstrap/state.js';
import { ManagedSettingsSecurityDialog } from '../../components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.js';
import { extractDangerousSettings, hasDangerousSettings, hasDangerousSettingsChanged } from '../../components/ManagedSettingsSecurityDialog/utils.js';
import { Box, render, Text } from '../../ink.js';
import { accountDisabledReason, disableAccountForSession, readStoreView, sessionAnthropicAccountId } from '../accounts/sessionAccounts.js';
import { getOauthAccountInfo } from '../../utils/auth.js';
import { readAccountInfo } from '../accounts/anthropicAccounts.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { AppStateProvider } from '../../state/AppState.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getBaseRenderOptions } from '../../utils/renderOptions.js';
import type { SettingsJson } from '../../utils/settings/types.js';
import { logEvent } from '../analytics/index.js';
export type SecurityCheckResult = 'approved' | 'rejected' | 'no_check_needed';

/**
 * Check if new remote managed settings contain dangerous settings that require user approval.
 * Shows a blocking dialog if dangerous settings have changed or been added.
 *
 * @param cachedSettings The current cached settings (may be null for first run)
 * @param newSettings The new settings fetched from the API
 * @returns 'approved' if user accepts, 'rejected' if user declines, 'no_check_needed' if no dangerous changes
 */
export async function checkManagedSettingsSecurity(cachedSettings: SettingsJson | null, newSettings: SettingsJson | null, accountId?: string): Promise<SecurityCheckResult> {
  // If new settings don't have dangerous settings, no check needed
  if (!newSettings || !hasDangerousSettings(extractDangerousSettings(newSettings))) {
    return 'no_check_needed';
  }

  // If dangerous settings haven't changed, no check needed
  if (!hasDangerousSettingsChanged(cachedSettings, newSettings)) {
    return 'no_check_needed';
  }

  // Skip dialog in non-interactive mode (consistent with trust dialog behavior)
  if (!getIsInteractive()) {
    return 'no_check_needed';
  }

  // Log that dialog is being shown
  logEvent('tengu_managed_settings_security_dialog_shown', {});

  // Whose settings these are, when the harness holds several Claude accounts.
  const header = accountHeader(accountId);

  // Show blocking dialog
  return new Promise<SecurityCheckResult>(resolve => {
    void (async () => {
      const {
        unmount
      } = await render(<AppStateProvider>
          <KeybindingSetup>
            {header ? <Box flexDirection="column"><Text bold color="warning">{header}</Text></Box> : null}
            <ManagedSettingsSecurityDialog settings={newSettings} onAccept={() => {
            logEvent('tengu_managed_settings_security_dialog_accepted', {});
            unmount();
            void resolve('approved');
          }} onReject={() => {
            logEvent('tengu_managed_settings_security_dialog_rejected', {});
            unmount();
            void resolve('rejected');
          }} />
          </KeybindingSetup>
        </AppStateProvider>, getBaseRenderOptions(false));
    })();
  });
}

/**
 * Handle the security check result by exiting if rejected
 * Returns true if we should continue, false if we should stop
 */
export function handleSecurityCheckResult(result: SecurityCheckResult): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1);
    return false;
  }
  return true;
}

/**
 * Pure: what rejecting the dialog of `accountId` does. The session's own
 * account (or a harness without other Claude accounts) exits, as before;
 * any other account is only disabled for this session.
 */
export function rejectionOutcome(accountId: string | undefined, sessionAccountId: string | null): 'exit' | 'disable' {
  if (!accountId || accountId === sessionAccountId) return 'exit';
  return 'disable';
}

/** handleSecurityCheckResult per Claude account: true = apply the new settings. */
export function handleAccountSecurityCheckResult(result: SecurityCheckResult, accountId?: string): boolean {
  if (result !== 'rejected') return true;
  if (rejectionOutcome(accountId, sessionAnthropicAccountId()) === 'exit') return handleSecurityCheckResult(result);
  logEvent('tengu_managed_settings_security_dialog_rejected', {});
  if (!accountDisabledReason(accountId!)) {
    disableAccountForSession(accountId!, 'rechazaste los ajustes gestionados de su organización');
  }
  return false;
}

/** «Cuenta claude-work · correo · organización», or null for a lone `claude`. */
function accountHeader(accountId: string | undefined): string | null {
  if (!accountId) return null;
  const others = Object.values(readStoreView().accounts).filter(a => a?.kind === 'anthropic').length;
  if (accountId === 'claude' && others <= 1) return null;
  const info = accountId !== 'claude' ? readAccountInfo(accountId) : getOauthAccountInfo();
  const who = [info?.emailAddress, info?.organizationName].filter(Boolean).join(' · ');
  const onlyThis = rejectionOutcome(accountId, sessionAnthropicAccountId()) === 'disable' ? '. Rechazar (No / Esc) solo desactiva esta cuenta en la sesión; fnharness sigue abierto' : '';
  return `Cuenta ${accountId}${who ? ` · ${who}` : ''}: ajustes gestionados de su organización${onlyThis}`;
}


/**
 * Whether `newSettings` would show the dialog (new or changed dangerous
 * settings, interactive session). Used mid-session, where the dialog cannot be
 * drawn over the running REPL: the settings wait as pending instead.
 */
export function needsSecurityApproval(cachedSettings: SettingsJson | null, newSettings: SettingsJson | null): boolean {
  if (!newSettings || !hasDangerousSettings(extractDangerousSettings(newSettings))) return false;
  if (!hasDangerousSettingsChanged(cachedSettings, newSettings)) return false;
  return getIsInteractive();
}

/** Managed settings of a Claude account waiting for `/account approve <id>`. */
const pendingApproval = new Map<string, SettingsJson>();

export function setPendingApproval(accountId: string, settings: SettingsJson): void {
  pendingApproval.set(accountId, settings);
}

export function getPendingApproval(accountId: string): SettingsJson | undefined {
  return pendingApproval.get(accountId);
}

export function clearPendingApproval(accountId: string): void {
  pendingApproval.delete(accountId);
}

/** The header of the per-account dialog (also used by `/account approve`). */
export function accountDialogHeader(accountId: string): string | null {
  return accountHeader(accountId);
}
