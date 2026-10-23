import {
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
} from './monitorLines.js'

export const MONITOR_TOOL_NAME = 'Monitor'

export const MONITOR_DESCRIPTION =
  'Run a command in the background and receive each line of its output as an event'

const minutes = (ms: number) => Math.round(ms / 60000)

export const MONITOR_PROMPT = `Start a background monitor: runs a shell command and delivers every line it prints to stdout to you as a notification while you keep working. Use it to react to things as they happen instead of polling: tail a log for errors, poll a CI job or PR and print a line when its status changes, watch a directory for changes, follow a long-running script.

How to use it well:
- Write the command so it prints ONE line per event worth reacting to, and nothing else. Filter at the source (for example \`tail -F app.log | grep --line-buffered ERROR\`), because every line costs context. Use \`--line-buffered\` with grep/sed/awk, otherwise events arrive late.
- For polling, loop inside the command: \`prev=""; while true; do s=$(gh pr view 12 --json state -q .state); [ "$s" != "$prev" ] && echo "state: $s"; prev=$s; sleep 30; done\`.
- Only stdout is delivered. Redirect stderr into stdout (\`2>&1\`) if you need it.
- Each watch has a deadline: ${minutes(MONITOR_DEFAULT_TIMEOUT_MS)} minutes by default, at most ${minutes(MONITOR_MAX_TIMEOUT_MS)} (timeout_ms). At the deadline the watch ends and you get one notice; start it again if still needed. Pass persistent: true for no deadline (it then runs until the session ends or you stop it).
- Output that is too fast is rate limited (excess lines are dropped and reported), and a watch that floods is stopped.
- The command follows the same permission rules as Bash.
- Stop a monitor with TaskStop using the task id this tool returns. When the script exits you get a "stream ended" notice.
- Optional include/exclude are regular expressions applied to each line before delivery.

Do not use Monitor for a one-shot "wait until done": use Bash with run_in_background for that.`
