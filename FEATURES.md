# Feature Flags Audit

Audit date: 2026-03-31

This repository currently references 88 `feature('FLAG')` compile-time flags.
I re-checked them by bundling the CLI once per flag on top of the current
external-build defines and externals. Result:

- 54 flags bundle cleanly in this snapshot
- 34 flags still fail to bundle

FnHarness note (24/10/2026): the default build (`scripts/build.ts`, `defaultFeatures`) now
enables `VOICE_MODE`, `AGENT_TRIGGERS` and `MONITOR_TOOL`. `AGENT_TRIGGERS_REMOTE` (cloud
triggers, needs Anthropic services) stays off. `MONITOR_TOOL` compiles now: the tool lives in
`src/tools/MonitorTool/`.

FnHarness note (24/10/2026): the Matrix event channel (`FNHARNESS_EVENTS` JSONL out,
`FNHARNESS_INPUT` FIFO in; contract in `docs/matrix_events.md`) is not behind a compile flag. It is
always built in and off at runtime: without those environment variables nothing is written or read.

FnHarness note (24/10/2026, fallback-hooks): the `fallbackModel` setting / `--fallback-model a,b,c`
chain works across accounts (`qwen36`, `claude:haiku`, `openrouter:x/y`) and the hook events
`PostToolBatch`, `DirectoryAdded`, `PreModelSwitch` and `PostModelSwitch` exist. None of it is behind a
feature flag. The remaining official events and the `mcp_tool` hook type came with the next note.

FnHarness note (25/10/2026, small-pack): the hook events `UserPromptExpansion` (a typed /command is
about to expand; can block it or add context; the matcher is `command_name`) and `MessageDisplay`
(replaces the text shown for a finished assistant message, display only), plus the `mcp_tool` hook
type (calls a tool of a configured MCP server, `${path}` substitution over the hook input), exist
with no feature flag. `Esc` on an idle prompt cancels a pending autopaced `/loop` wake-up ("Pending
wakeup cancelled"). The `PushNotification` tool is local: a silent desktop notification through
`notify-send` when present, else a notice in the TUI; `pushNotificationEnabled: false` removes it.
Limits and details: `docs/plans/claude_code_gap.md`.

FnHarness note (24/10/2026, account-routing): a model written as `cuenta:modelo` is served by that
account for that request only (`Agent` tool `model`, agent frontmatter, `/model cuenta:modelo`), so a
subagent can run on `claude:haiku` from a local-model session and the other way round; `/model` lists
the models of every connected account grouped by account. No feature flag. Design:
`docs/plans/account_routing.md`.

FnHarness note (24/10/2026, context-profile): `/scope` and Ctrl+Tab choose what reaches the model
per request (MCP servers by config scope, skills by origin, built-in tools full/simple/none), remembered
per account (`contextProfile` in `accounts.json` / `.claude.json`); local backends default to Simple.
Not behind a feature flag. See `docs/plans/context_profile.md`.

FnHarness note (24/10/2026, mcp-reload): MCP servers hot-reload without a restart and none of it is
behind a build flag. `/mcp reload [server]` and `/mcp reconnect all`; a watcher over every
`.mcp.json` from the cwd upwards and the global `.claude.json` (set `FNHARNESS_MCP_WATCH=0` to turn it
off); local (stdio) servers that die are relaunched with backoff (4 attempts, budget restored after
60 s of stable uptime); and the model gets a short system reminder when the tool set of a server
changes. Details in `docs/plans/mcp_reload.md`.

Important: "bundle cleanly" does not always mean "runtime-safe". Some flags
still depend on optional native modules, claude.ai OAuth, GrowthBook gates, or
externalized `@ant/*` packages.

## Build Variants

- `bun run build`
  Builds the regular external binary at `./cli`.
- `bun run compile`
  Builds the regular external binary at `./dist/cli`.
- `bun run build:dev`
  Builds `./cli-dev` with a dev-stamped version and experimental GrowthBook key.
- `bun run build:dev:full`
  Builds `./cli-dev` with the entire current "Working Experimental Features"
  bundle from this document, minus `CHICAGO_MCP`. That flag still compiles,
  but the external binary does not boot cleanly with it because startup
  reaches the missing `@ant/computer-use-mcp` runtime package.

## Default Build Flags

- `VOICE_MODE`
  This is now included in the default build pipeline, not just the dev build.
  It enables `/voice`, push-to-talk UI, voice notices, and dictation plumbing.
  Runtime still depends on claude.ai OAuth plus either the native audio module
  or a fallback recorder such as SoX.

- `AGENT_TRIGGERS`
  Local scheduling: `CronCreate`/`CronList`/`CronDelete`, `ScheduleWakeup` and
  `/loop` (fixed interval via cron, or self-paced with `ScheduleWakeup`). Fully
  local, so it works with OpenAI-compatible accounts. Session-scoped tasks;
  recurring tasks expire after 7 days. `CLAUDE_CODE_DISABLE_CRON=1` turns it off.
- `/goal` (always on, no flag)
  Built-in command that keeps the agent working until an evaluator says the
  condition holds (or is impossible). Works in the TUI and in `-p`. Stops after
  3 tool-less turns or a turn cap (`--turns`, default 30). The evaluator defaults
  to the active account; `--judge <account>`, `FNHARNESS_GOAL_JUDGE` or the
  `goalJudge` setting pick another one (small local models judge poorly).
- `/fork` and `/subtask` (always on, no flag)
  `/fork [--model m] <instruction>` starts a background subagent that inherits the
  whole current conversation (Agent tool with `subagent_type: "fork"`, which now
  takes the fork path even with `FORK_SUBAGENT` off); `/subtask` starts one with a
  clean context (`general-purpose`, only its prompt). Both show in the agents
  panel and notify on completion. `--model` takes `sonnet|opus|haiku` or
  `account:model`. The command asks the model to make the Agent call, so a weak
  model may need a retry. `/branch` no longer has the `fork` alias.
- `MONITOR_TOOL`
  The `Monitor` tool: runs a shell command in the background and delivers each
  stdout line to the model as a `<task-notification>` event (batched, filtered,
  rate limited). Shows as a monitor in the footer pill and stops with `TaskStop`.
  Local only; unlike Claude Code it is not disabled by
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which multimodel mode always sets.
  The WebSocket source of Claude Code's Monitor is not implemented.

- `BG_SESSIONS`
  Background sessions without tmux or a daemon. `fnharness --bg "<prompt>"`
  launches a detached headless run (`-p --output-format stream-json`, own process
  group) and prints its id; `fnharness ps`, `logs <id> [-f]`, `stop <id>`
  (alias `kill`), `attach <id>` and `rm <id>` manage it, and `/background <prompt>`
  (alias `/bg`) starts one from the TUI forking the current conversation.
  State lives in `<CLAUDE_CONFIG_DIR>/bg/<id>/` (`meta.json`, `events.jsonl`,
  `stderr.log`, `exit`). Limits: `attach` on a running session only follows its
  log (no live takeover); a headless run cannot answer permission prompts, so it
  needs a permission mode that pre-approves its tools; no `respawn` or agent
  view yet. Code: `src/cli/bgCore.ts` (pure) and `src/cli/bg.ts` (effects).

## Working Experimental Features

These are the user-facing or behavior-changing flags that currently bundle
cleanly and should still be treated as experimental in this snapshot unless
explicitly called out as default-on.

### Interaction and UI Experiments

- `AWAY_SUMMARY`
  Adds away-from-keyboard summary behavior in the REPL (automatic card after blur; also
  needs GrowthBook `tengu_sedge_lantern`, off for 3P). The manual `/recap` command does
  not depend on this flag.
- `HISTORY_PICKER`
  Enables the interactive prompt history picker.
- `HOOK_PROMPTS`
  Passes the prompt/request text into hook execution flows.
- `KAIROS_BRIEF`
  Enables brief-only transcript layout and BriefTool-oriented UX without the
  full assistant stack.
- `KAIROS_CHANNELS`
  Enables channel notices and channel callback plumbing around MCP/channel
  messaging.
- `LODESTONE`
  Enables deep-link / protocol-registration related flows and settings wiring.
- `MESSAGE_ACTIONS`
  Enables message action entrypoints in the interactive UI.
- `NEW_INIT`
  Enables the newer `/init` decision path.
- `QUICK_SEARCH`
  Enables prompt quick-search behavior.
- `SHOT_STATS`
  Enables additional shot-distribution stats views.
- `TOKEN_BUDGET`
  Enables token budget tracking, prompt triggers, and token warning UI.
- `ULTRAPLAN`
  Enables `/ultraplan`, prompt triggers, and exit-plan affordances.
- `ULTRATHINK`
  Enables the extra thinking-depth mode switch.
- `VOICE_MODE`
  Enables voice toggling, dictation keybindings, voice notices, and voice UI.

### Agent, Memory, and Planning Experiments

- `AGENT_MEMORY_SNAPSHOT`
  Stores extra custom-agent memory snapshot state in the app.
- `AGENT_TRIGGERS` (default build)
  Enables local cron/trigger tools (`CronCreate`, `CronList`, `CronDelete`), the
  `ScheduleWakeup` tool and the bundled `/loop` skill (fixed interval and self-paced).
- `AGENT_TRIGGERS_REMOTE`
  Enables the remote trigger tool path.
- `BUILTIN_EXPLORE_PLAN_AGENTS`
  Enables built-in explore/plan agent presets.
- `CACHED_MICROCOMPACT`
  Enables cached microcompact state through query and API flows.
- `COMPACTION_REMINDERS`
  Enables reminder copy around compaction and attachment flows.
- `EXTRACT_MEMORIES`
  Enables post-query memory extraction hooks.
- `PROMPT_CACHE_BREAK_DETECTION`
  Enables cache-break detection around compaction/query/API flow.
- `TEAMMEM`
  Enables team-memory files, watcher hooks, and related UI messages.
- `VERIFICATION_AGENT`
  Enables verification-agent guidance in prompts and task/todo tooling.

### Tools, Permissions, and Remote Experiments

- `BASH_CLASSIFIER`
  Enables classifier-assisted bash permission decisions.
- `BRIDGE_MODE`
  Enables Remote Control / REPL bridge command and entitlement paths.
- `CCR_AUTO_CONNECT`
  Enables the CCR auto-connect default path.
- `CCR_MIRROR`
  Enables outbound-only CCR mirror sessions.
- `CCR_REMOTE_SETUP`
  Enables the remote setup command path.
- `CHICAGO_MCP`
  Enables computer-use MCP integration paths and wrapper loading.
- `CONNECTOR_TEXT`
  Enables connector-text block handling in API/logging/UI paths.
- `MCP_RICH_OUTPUT`
  Enables richer MCP UI rendering.
- `NATIVE_CLIPBOARD_IMAGE`
  Enables the native macOS clipboard image fast path.
- `POWERSHELL_AUTO_MODE`
  Enables PowerShell-specific auto-mode permission handling.
- `TREE_SITTER_BASH`
  Enables the tree-sitter bash parser backend.
- `TREE_SITTER_BASH_SHADOW`
  Enables the tree-sitter bash shadow rollout path.
- `UNATTENDED_RETRY`
  Enables unattended retry behavior in API retry flows.

## Bundle-Clean Support Flags

These also bundle cleanly, but they are mostly rollout, platform, telemetry,
or plumbing toggles rather than user-facing experimental features.

- `ABLATION_BASELINE`
  CLI ablation/baseline entrypoint toggle.
- `ALLOW_TEST_VERSIONS`
  Allows test versions in native installer flows.
- `ANTI_DISTILLATION_CC`
  Adds anti-distillation request metadata.
- `BREAK_CACHE_COMMAND`
  Injects the break-cache command path.
- `COWORKER_TYPE_TELEMETRY`
  Adds coworker-type telemetry fields.
- `DOWNLOAD_USER_SETTINGS`
  Enables settings-sync pull paths.
- `DUMP_SYSTEM_PROMPT`
  Enables the system-prompt dump path.
- `FILE_PERSISTENCE`
  Enables file persistence plumbing.
- `HARD_FAIL`
  Enables stricter failure/logging behavior.
- `IS_LIBC_GLIBC`
  Forces glibc environment detection.
- `IS_LIBC_MUSL`
  Forces musl environment detection.
- `NATIVE_CLIENT_ATTESTATION`
  Adds native attestation marker text in the system header.
- `PERFETTO_TRACING`
  Enables perfetto tracing hooks.
- `SKILL_IMPROVEMENT`
  Enables skill-improvement hooks.
- `SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED`
  Skips updater detection when auto-updates are disabled.
- `SLOW_OPERATION_LOGGING`
  Enables slow-operation logging.
- `UPLOAD_USER_SETTINGS`
  Enables settings-sync push paths.

## Compile-Safe But Runtime-Caveated

These bundle today, but I would still treat them as experimental because they
have meaningful runtime caveats:

- `VOICE_MODE`
  Bundles cleanly, but requires claude.ai OAuth and a local recording backend.
  The native audio module is optional now; on this machine the fallback path
  asks for `brew install sox`.
- `NATIVE_CLIPBOARD_IMAGE`
  Bundles cleanly, but only accelerates macOS clipboard reads when
  `image-processor-napi` is present.
- `BRIDGE_MODE`, `CCR_AUTO_CONNECT`, `CCR_MIRROR`, `CCR_REMOTE_SETUP`
  Bundle cleanly, but are gated at runtime on claude.ai OAuth plus GrowthBook
  entitlement checks.
- `KAIROS_BRIEF`, `KAIROS_CHANNELS`
  Bundle cleanly, but they do not restore the full missing assistant stack.
  They only expose the brief/channel-specific surfaces that still exist.
- `CHICAGO_MCP`
  Bundles cleanly, but the runtime path still reaches externalized
  `@ant/computer-use-*` packages. This is compile-safe, not fully
  runtime-safe, in the external snapshot.
- `TEAMMEM`
  Bundles cleanly, but only does useful work when team-memory config/files are
  actually enabled in the environment.

## Broken Flags With Easy Reconstruction Paths

These are the failed flags where the current blocker looks small enough that a
focused reconstruction pass could probably restore them without rebuilding an
entire subsystem.

- `AUTO_THEME`
  Fails on missing `src/utils/systemThemeWatcher.js`. `systemTheme.ts` and the
  theme provider already contain the cache/parsing logic, so the missing piece
  looks like the OSC 11 watcher only.
- `BUDDY`
  Fails on missing `src/commands/buddy/index.js`. The buddy UI components and
  prompt-input hooks already exist.
- `BUILDING_CLAUDE_APPS`
  Fails on missing `src/claude-api/csharp/claude-api.md`. This looks like an
  asset/document gap, not a missing runtime subsystem.
- `COMMIT_ATTRIBUTION`
  Fails on missing `src/utils/attributionHooks.js`. Setup and cache-clear code
  already call into that hook module.
- `FORK_SUBAGENT`
  The commands now exist (`/fork`, `/subtask`, always on). Enabling the flag itself
  is still not advised: it forces every Agent spawn into the background and its
  message renderer (`UserForkBoilerplateMessage`) is missing.
- `HISTORY_SNIP`
  Fails on missing `src/commands/force-snip.js`. The surrounding SnipTool and
  query/message comments are already there.
- `KAIROS_GITHUB_WEBHOOKS`
  Fails on missing `src/tools/SubscribePRTool/SubscribePRTool.js`. The command
  slot and some message handling already exist.
- `KAIROS_PUSH_NOTIFICATION` (no longer needed)
  Replaced on 25/10/2026 by a local `PushNotification` tool that is always built in (`notify-send`
  or a TUI notice, silent; `pushNotificationEnabled: false` disables it). The mobile push that
  depends on Remote Control is not implemented.
- `MCP_SKILLS`
  Fails on missing `src/skills/mcpSkills.js`. `mcpSkillBuilders.ts` already
  exists specifically to support that missing registry layer.
- `MEMORY_SHAPE_TELEMETRY`
  Fails on missing `src/memdir/memoryShapeTelemetry.js`. The hook call sites
  are already in place in `sessionFileAccessHooks.ts`.
- `OVERFLOW_TEST_TOOL`
  Fails on missing `src/tools/OverflowTestTool/OverflowTestTool.js`. This
  appears isolated and test-only.
- `RUN_SKILL_GENERATOR`
  Fails on missing `src/runSkillGenerator.js`. The bundled skill registration
  path already expects it.
- `TEMPLATES`
  Fails on missing `src/cli/handlers/templateJobs.js`. The CLI fast-path is
  already wired in `src/entrypoints/cli.tsx`.
- `TORCH`
  Fails on missing `src/commands/torch.js`. This looks like a single command
  entry gap.
- `TRANSCRIPT_CLASSIFIER`
  The first hard failure is missing
  `src/utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt`.
  The classifier engine, parser, and settings plumbing already exist, so the
  missing prompt/assets are likely the first reconstruction target.

## Broken Flags With Partial Wiring But Medium-Sized Gaps

These do have meaningful surrounding code, but the missing piece is larger
than a single wrapper or asset.

- `BYOC_ENVIRONMENT_RUNNER`
  Missing `src/environment-runner/main.js`.
- `CONTEXT_COLLAPSE`
  Missing `src/tools/CtxInspectTool/CtxInspectTool.js`.
- `COORDINATOR_MODE`
  Missing `src/coordinator/workerAgent.js`.
- `DAEMON`
  Missing `src/daemon/workerRegistry.js`.
- `DIRECT_CONNECT`
  Missing `src/server/parseConnectUrl.js`.
- `EXPERIMENTAL_SKILL_SEARCH`
  Missing `src/services/skillSearch/localSearch.js`.
- `REACTIVE_COMPACT`
  Missing `src/services/compact/reactiveCompact.js`.
- `REVIEW_ARTIFACT`
  Missing `src/hunter.js`.
- `SELF_HOSTED_RUNNER`
  Missing `src/self-hosted-runner/main.js`.
- `SSH_REMOTE`
  Missing `src/ssh/createSSHSession.js`.
- `TERMINAL_PANEL`
  Missing `src/tools/TerminalCaptureTool/TerminalCaptureTool.js`.
- `UDS_INBOX`
  Missing `src/utils/udsMessaging.js`.
- `WEB_BROWSER_TOOL`
  Missing `src/tools/WebBrowserTool/WebBrowserTool.js`.
- `WORKFLOW_SCRIPTS`
  Fails first on `src/commands/workflows/index.js`, but there are more gaps:
  `tasks.ts` already expects `LocalWorkflowTask`, and `tools.ts` expects a
  real `WorkflowTool` implementation while only `WorkflowTool/constants.ts`
  exists in this snapshot.

## Broken Flags With Large Missing Subsystems

These are the ones that still look expensive to restore because the first
missing import is only the visible edge of a broader absent subsystem.

- `KAIROS`
  Missing `src/assistant/index.js` and much of the assistant stack with it.
- `KAIROS_DREAM`
  Missing `src/dream.js` and related dream-task behavior.
- `PROACTIVE`
  Missing `src/proactive/index.js` and the proactive task/tool stack.

## Useful Entry Points

- Feature-aware build logic:
  [scripts/build.ts](/Users/paolo/Repos/claude-code/scripts/build.ts)
- Feature-gated command imports:
  [src/commands.ts](/Users/paolo/Repos/claude-code/src/commands.ts)
- Feature-gated tool imports:
  [src/tools.ts](/Users/paolo/Repos/claude-code/src/tools.ts)
- Feature-gated task imports:
  [src/tasks.ts](/Users/paolo/Repos/claude-code/src/tasks.ts)
- Feature-gated query behavior:
  [src/query.ts](/Users/paolo/Repos/claude-code/src/query.ts)
- Feature-gated CLI entry paths:
  [src/entrypoints/cli.tsx](/Users/paolo/Repos/claude-code/src/entrypoints/cli.tsx)
