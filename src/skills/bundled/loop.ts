import { readFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
  SCHEDULE_WAKEUP_TOOL_NAME,
} from '../../tools/ScheduleCronTool/prompt.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  intervalToCron,
  LOOP_SENTINEL,
  parseLoopArgs,
  WAKEUP_MAX_SECONDS,
  WAKEUP_MIN_SECONDS,
} from '../../utils/loopSchedule.js'
import { registerBundledSkill } from '../bundledSkills.js'

const LOOP_MD_MAX_BYTES = 25_000

const USAGE_MESSAGE = `Usage: /loop [interval] [prompt]

Run a prompt or slash command repeatedly while this session stays open.

  /loop 5m check the deploy      fixed schedule (Ns, Nm, Nh, Nd; seconds round up to a minute)
  /loop check the deploy         no interval: you pick the delay (1 min to 1 h) after each iteration
  /loop 15m                      fixed schedule running the built-in maintenance prompt
  /loop                          self-paced, built-in maintenance prompt (or .claude/loop.md)

Examples:
  /loop 5m /babysit-prs
  /loop check the deploy every 20m
  /loop check whether CI passed and address review comments`

/** Prompt run by a bare /loop when no loop.md exists. */
export const BUILT_IN_MAINTENANCE_PROMPT = `Maintenance pass. Work through this in order and stop at the first item that has work to do:
1. Continue any unfinished work from this conversation.
2. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts.
3. If nothing else is pending, run a cleanup pass such as a bug hunt or a simplification of recent changes.

Do not start new initiatives outside that scope. Irreversible actions such as pushing or deleting only proceed when they continue something this conversation already authorized.`

async function readLoopMd(): Promise<string | null> {
  const candidates = [
    join(getProjectRoot(), '.claude', 'loop.md'),
    join(getClaudeConfigHomeDir(), 'loop.md'),
  ]
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf-8')
      if (text.trim() !== '') return text.slice(0, LOOP_MD_MAX_BYTES)
    } catch {
      // Missing or unreadable: try the next location.
    }
  }
  return null
}

/** Build the instruction text for one /loop invocation. Pure: loop.md is passed in. */
export function buildLoopPrompt(args: string, loopMd: string | null): string {
  const parsed = parseLoopArgs(args)
  const maintenance = loopMd ?? BUILT_IN_MAINTENANCE_PROMPT
  const body = parsed.prompt ?? maintenance
  const how = `If the prompt below is a slash command, invoke it with the Skill tool; otherwise act on it directly.`

  if (parsed.mode === 'fixed') {
    const { cron, human, roundedNote } = intervalToCron(parsed.interval)
    return `# /loop: fixed schedule

Schedule the prompt below ${human} with ${CRON_CREATE_TOOL_NAME}.

## Steps

1. Call ${CRON_CREATE_TOOL_NAME} with \`cron\`: \`${cron}\`, \`recurring\`: true, and \`prompt\`: the prompt below, verbatim.
2. Confirm briefly: what is scheduled, the cadence (${human}), the job ID, that it auto-expires after ${DEFAULT_MAX_AGE_DAYS} days, and that ${CRON_DELETE_TOOL_NAME} cancels it sooner.${roundedNote ? ` Tell the user: ${roundedNote}.` : ''}
3. Then run the prompt once now, without waiting for the first fire. ${how}

## Prompt

${body}`
  }

  const loopInput = parsed.prompt === null ? LOOP_SENTINEL : `/loop ${args.trim()}`
  return `# /loop: self-paced

You are running a loop that has no fixed interval: after every iteration YOU choose when the next one happens.

## Steps

1. Do this iteration's work now. ${how}
2. When the iteration is done, decide how long to wait and call ${SCHEDULE_WAKEUP_TOOL_NAME} with:
   - \`delaySeconds\`: between ${WAKEUP_MIN_SECONDS} and ${WAKEUP_MAX_SECONDS}. Short (${WAKEUP_MIN_SECONDS}-270) while something is actively changing, such as a build finishing or a PR with fresh activity; long (1200-3600) when nothing is pending.
   - \`prompt\`: exactly \`${loopInput}\`
   - \`reason\`: one short sentence on why you chose that delay.
3. If the work is complete or the condition you were waiting for is met, call ${SCHEDULE_WAKEUP_TOOL_NAME} with \`stop: true\` instead, and tell the user the loop is over.
4. End the iteration with one line: the delay you chose and why.

If the Monitor tool is available and the work is "wait for something to happen" (a log line, a CI status change), prefer starting a Monitor over polling with wake-ups.

## Prompt

${body}`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model pick the delay each iteration.',
    whenToUse:
      'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.',
    argumentHint: '[interval] [prompt]',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const trimmed = args.trim()
      if (trimmed === '--help' || trimmed === 'help') {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }
      const parsed = parseLoopArgs(trimmed)
      const needsMd = parsed.prompt === null
      const md = needsMd ? await readLoopMd() : null
      return [{ type: 'text', text: buildLoopPrompt(trimmed, md) }]
    },
  })
}
