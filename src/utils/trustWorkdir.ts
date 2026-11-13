/**
 * --trust-workdir <dir>: trust the working directory of an unattended session
 * (a Matrix room launched inside tmux) without showing the trust dialog.
 *
 * Contract (docs/trust_workdir.md):
 * - Only the CLI flag enables it. There is deliberately NO environment
 *   variable: a child process inherits the environment, a flag it does not.
 * - The directory given must be the real current working directory. Anything
 *   else is rejected and the normal dialog stays in charge.
 * - What is persisted is exactly what accepting the dialog persists
 *   (`projects[<dir>].hasTrustDialogAccepted`), but keyed by the exact cwd
 *   instead of the enclosing git root, so a sala never trusts more than its
 *   own folder.
 * - While active, the dialogs that would come right after trust and need a
 *   human are answered "yes" for this session only (nothing is persisted):
 *   the bypass-permissions warning, the project .mcp.json approval and the
 *   CLAUDE.md external-includes warning.
 */

import { realpathSync } from 'fs'
import { resolve } from 'path'
import type { ProjectConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { normalizePathForConfigKey } from './path.js'

export type TrustWorkdirDecision =
  | { action: 'none'; reason: 'flag_absent' | 'non_interactive' | 'already_trusted' }
  | { action: 'trust'; key: string }
  | { action: 'reject'; reason: 'dir_mismatch' | 'dir_unreadable'; dir: string }

export type TrustWorkdirInput = {
  /** Value of --trust-workdir, undefined when the flag was not passed. */
  flagValue: string | undefined
  /** The session's real working directory. */
  cwd: string
  /** True for -p / SDK runs: they never show the dialog anyway. */
  nonInteractive: boolean
  /** Whether cwd (or an ancestor) is already trusted. */
  alreadyTrusted: boolean
  /** Injected for tests; defaults to fs.realpathSync. */
  realpath?: (p: string) => string
}

/** Pure decision: should the trust dialog be bypassed, and for which key. */
export function decideTrustWorkdir(input: TrustWorkdirInput): TrustWorkdirDecision {
  const { flagValue, cwd, nonInteractive, alreadyTrusted } = input
  if (flagValue === undefined || flagValue === '') return { action: 'none', reason: 'flag_absent' }
  if (nonInteractive) return { action: 'none', reason: 'non_interactive' }
  const real = input.realpath ?? ((p: string) => realpathSync(resolve(p)))
  let dir: string
  let here: string
  try {
    dir = real(flagValue)
    here = real(cwd)
  } catch {
    return { action: 'reject', reason: 'dir_unreadable', dir: flagValue }
  }
  if (dir !== here) return { action: 'reject', reason: 'dir_mismatch', dir: flagValue }
  if (alreadyTrusted) return { action: 'none', reason: 'already_trusted' }
  return { action: 'trust', key: normalizePathForConfigKey(here) }
}

let _active = false

/**
 * True once --trust-workdir was honoured in this process (including when the
 * folder was already trusted). Gates the session-only auto-answers.
 */
export function isTrustWorkdirActive(): boolean {
  return _active
}

export function setTrustWorkdirActiveForTesting(value: boolean): void {
  _active = value
}

/** Updater for the project config: marks it trusted, same reference when it already was. */
export function markProjectTrusted(project: ProjectConfig): ProjectConfig {
  return project.hasTrustDialogAccepted ? project : { ...project, hasTrustDialogAccepted: true }
}

/**
 * Applies the flag at startup, before the setup screens. Logs the outcome in
 * the debug log; a rejected flag falls back to the normal trust dialog.
 */
export async function applyTrustWorkdir(
  flagValue: string | undefined,
  cwd: string,
  nonInteractive: boolean,
): Promise<TrustWorkdirDecision> {
  if (flagValue === undefined) return { action: 'none', reason: 'flag_absent' }
  const { checkHasTrustDialogAccepted, saveProjectConfigAt } = await import('./config.js')
  const decision = decideTrustWorkdir({
    flagValue,
    cwd,
    nonInteractive,
    alreadyTrusted: nonInteractive ? false : checkHasTrustDialogAccepted(),
  })
  switch (decision.action) {
    case 'trust':
      saveProjectConfigAt(decision.key, markProjectTrusted)
      _active = true
      logForDebugging(`[trust-workdir] trusted ${decision.key} (--trust-workdir, no dialog)`)
      break
    case 'reject':
      logForDebugging(
        `[trust-workdir] rejected: ${decision.dir} is not the working directory (${decision.reason}); the trust dialog stays`,
        { level: 'warn' },
      )
      process.stderr.write(
        `--trust-workdir ignored: ${decision.dir} is not the current working directory (${decision.reason}).\n`,
      )
      break
    case 'none':
      if (decision.reason === 'already_trusted') {
        _active = true
        logForDebugging(`[trust-workdir] ${cwd} already trusted (--trust-workdir, no change)`)
      }
      break
  }
  return decision
}
