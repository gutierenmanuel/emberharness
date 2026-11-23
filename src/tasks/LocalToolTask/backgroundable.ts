// Central policy for which tool calls may be moved to the background as a
// `local_tool` task (Ctrl+B or the auto-background timer).
//
// Kept in one place on purpose: a tool opts out by name here (or by setting
// `backgroundable` on its definition) instead of scattering flags across the
// tool implementations. Names are string literals to avoid importing every
// tool module (and the import cycles that come with it).

import type { Tool } from '../../Tool.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * Tools that must never run as a `local_tool` background task:
 * - Bash, PowerShell, Agent, Monitor, Workflow: already own a background
 *   mechanism (shell / agent / workflow tasks).
 * - Read, Edit, Write, MultiEdit, NotebookEdit, Glob, Grep, ToolSearch,
 *   TodoWrite, Task*: instant or local-state tools.
 * - AskUserQuestion, plan mode, worktree, Config, Skill, REPL,
 *   StructuredOutput, SendMessage, team and cron tools: interactive, or
 *   their result mutates turn/session state (contextModifier, newMessages,
 *   permission mode, cwd) that a detached result could not apply. The MCP
 *   authenticate tool opts out with `backgroundable: false` on its definition.
 * - Sleep: waiting is its whole purpose; backgrounding it is meaningless.
 */
export const NON_BACKGROUNDABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'PowerShell',
  'Agent',
  'Task',
  'Monitor',
  'Workflow',
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Config',
  'Skill',
  'REPL',
  'StructuredOutput',
  'SendMessage',
  'SendUserMessage',
  'Brief',
  'TeamCreate',
  'TeamDelete',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'Sleep',
  'VerifyPlanExecution',
  'Tungsten',
])

/** Delay before a running tool registers as a foreground task (Ctrl+B target). Matches Bash's PROGRESS_THRESHOLD_MS. */
export const TOOL_FOREGROUND_REGISTER_DELAY_MS = 2_000

/** Default auto-background threshold. Matches Bash's default timeout, after which Bash auto-backgrounds. */
export const DEFAULT_TOOL_AUTO_BACKGROUND_MS = 120_000

export const TOOL_AUTO_BACKGROUND_ENV = 'FNHARNESS_TOOL_AUTO_BACKGROUND_MS'

/**
 * Auto-background threshold in ms from FNHARNESS_TOOL_AUTO_BACKGROUND_MS.
 * 0 (or a negative number) disables auto-background; Ctrl+B still works.
 * Unset or unparsable falls back to DEFAULT_TOOL_AUTO_BACKGROUND_MS.
 */
export function getToolAutoBackgroundMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[TOOL_AUTO_BACKGROUND_ENV]
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TOOL_AUTO_BACKGROUND_MS
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_TOOL_AUTO_BACKGROUND_MS
  return n <= 0 ? 0 : Math.floor(n)
}

/** True when this tool's calls may become `local_tool` background tasks. */
export function isToolBackgroundable(
  tool: Pick<Tool, 'name' | 'backgroundable' | 'requiresUserInteraction'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isEnvTruthy(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return false
  if (tool.backgroundable !== undefined) return tool.backgroundable
  if (NON_BACKGROUNDABLE_TOOL_NAMES.has(tool.name)) return false
  if (tool.requiresUserInteraction?.()) return false
  return true
}
