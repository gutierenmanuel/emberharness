/**
 * Compact prompts for the context profile `tools:simple`.
 *
 * A small local model (qwen36, 32k window) cannot afford the full Claude Code
 * system prompt (~6k tokens) and the long tool descriptions (~5k tokens). With
 * the Simple tool set (Bash, Read, Write, Edit, Glob, Grep, Agent) we send:
 *
 *   - a short system prompt of our own (identity, environment, a few rules);
 *   - one-paragraph descriptions for the seven tools.
 *
 * The input schemas of the tools are NOT touched here: only the description
 * text that `toolToAPISchema` would take from `tool.prompt()` is replaced.
 * Project and user CLAUDE.md files keep arriving through the user context, as
 * in every other profile.
 */

import { SIMPLE_TOOL_NAMES } from '../utils/contextProfile.js'

/**
 * True when `tools` is the Simple set (the six file/shell tools, with or
 * without Agent, nothing else). The profile itself is not visible from
 * `getSystemPrompt` / `toolToAPISchema`, but the tool pool is, and only
 * `tools:simple` produces it. Smaller sets (a subagent with Read and Grep)
 * keep the regular prompts.
 */
export function isCompactToolSet(tools: ReadonlyArray<{ name: string }>): boolean {
  return (
    tools.length >= SIMPLE_TOOL_NAMES.size - 1 &&
    tools.every(t => SIMPLE_TOOL_NAMES.has(t.name))
  )
}

export type CompactEnv = {
  cwd: string
  isGit: boolean
  platform: string
  shell: string
  osVersion: string
  date: string
  additionalDirs?: string[]
  language?: string
}

/** Short system prompt for the Simple profile. Pure: all inputs are passed in. */
export function buildCompactSystemPrompt(env: CompactEnv): string {
  const lines = [
    'You are fnharness, a coding assistant that runs in the user\'s terminal and works on their machine through tools.',
    '',
    '# Environment',
    `- Working directory: ${env.cwd}`,
    `- Git repository: ${env.isGit ? 'yes' : 'no'}`,
    `- Platform: ${env.platform} (${env.osVersion}), shell: ${env.shell}`,
    `- Date: ${env.date}`,
  ]
  if (env.additionalDirs && env.additionalDirs.length > 0) {
    lines.push(`- Extra directories: ${env.additionalDirs.join(', ')}`)
  }
  lines.push(
    '',
    '# Using the tools',
    '- Only report what tool results show. To create or change a file call Write or Edit, to run something call Bash, to look at a file call Read; make the call first, then report.',
    '- Read a file before you edit it and check the result of every command.',
    '- Use Read, Write, Edit, Glob and Grep for files and search; use Bash only for commands (builds, tests, git, scripts).',
    '- Do the task you were asked, nothing more. Ask first only when it is truly ambiguous.',
    '- Delegate wide searches or side tasks to a subagent with Agent so your context stays small.',
    '',
    '# Safety',
    '- Avoid destructive commands (rm -rf, git reset --hard, force push) and pushing unless the user asked. Never print or commit secrets.',
    '- Help with defensive security only; refuse to build malware or attack tools.',
    '',
    '# Style',
    '- Go straight to the point. Lead with the action, not the reasoning. Do not restate what the user said: just do it. Keep text output brief; no filler, preamble or recap. No emojis unless asked.',
    '- Refer to code as file_path:line_number.',
  )
  if (env.language) lines.push(`- Always answer in ${env.language}.`)
  return lines.join('\n')
}

const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: 'Run a shell command in the working directory and return stdout and stderr. Use it for builds, tests, git and scripts, not for reading, searching or editing files (use Read, Grep, Glob, Edit, Write). Quote paths with spaces; chain dependent commands with &&; avoid interactive commands. Output is truncated when very long. Optional timeout in ms (default 120000, max 600000); run_in_background=true runs it detached. Always fill description with a few words saying what the command does.',
  Read: 'Read a file from the local filesystem. file_path must be absolute. Returns lines with numbers; by default reads up to 2000 lines, use offset and limit for big files. Also reads images and PDFs (pages for PDFs) and Jupyter notebooks. Read it before you Edit or overwrite it.',
  Write: 'Write a file with the given content: creates it, or replaces its whole content. file_path must be absolute. To change part of a file that already has content, read it and use Edit instead. Do not create documentation files unless asked.',
  Edit: 'Replace an exact string in a file. Read the file first. old_string must match the file exactly (including indentation) and be unique, otherwise add context or set replace_all=true to change every occurrence. new_string must differ from old_string.',
  Glob: 'Find files by glob pattern (for example "**/*.ts"), sorted by modification time. Optional path is the directory to search; omit it for the working directory.',
  Grep: 'Search file contents with ripgrep regex. Always use this instead of grep or rg in Bash. Filter with glob (e.g. "*.ts") or type (e.g. "py"). output_mode: files_with_matches (default), content (matching lines; supports -n, -A, -B, -C) or count. Escape literal braces; use multiline=true for patterns that span lines.',
}

export type CompactAgentInfo = { agentType: string; whenToUse: string }

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/**
 * Compact description of the Agent tool. `agents` is listed unless the agent
 * list travels in a message attachment instead (`listAgents` false).
 */
export function compactAgentDescription(
  agents: readonly CompactAgentInfo[],
  listAgents: boolean,
): string {
  const parts = [
    'Launch a subagent that works on its own and returns one final report. It does not see this conversation, so the prompt must be self-contained: goal, relevant paths, constraints and what to report back. Use it for wide searches or independent side tasks; do the work yourself when it takes a couple of tool calls. Pass description (3-5 words), prompt and optionally subagent_type; launch independent agents in the same turn.',
  ]
  if (listAgents && agents.length > 0) {
    parts.push(
      'Agent types:\n' + agents.map(a => `- ${a.agentType}: ${oneLine(a.whenToUse, 90)}`).join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** Compact description for a tool of the Simple set, or undefined. */
export function compactToolDescription(
  name: string,
  agents: readonly CompactAgentInfo[],
  listAgents: boolean,
): string | undefined {
  if (name === 'Agent') return compactAgentDescription(agents, listAgents)
  return COMPACT_TOOL_DESCRIPTIONS[name]
}
