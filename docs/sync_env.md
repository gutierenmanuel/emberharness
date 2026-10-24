# Paridad de entorno: `scripts/sync_env.sh`

`scripts/sync_env.sh` deja `${FNHARNESS_HOME:-$HOME/.fnharness}` alineado con la configuración de
Claude Code del dueño (`${CLAUDE_SRC:-$HOME/.claude}` y `$HOME/.claude.json`) sin copiar credenciales.
Es idempotente y está pensado para la fase 3 de `docs/plans/matrix_default_harness.md`.

## Uso

```
scripts/sync_env.sh --check     # solo lectura; imprime diferencias (nombres) y sale 1 si las hay
scripts/sync_env.sh --dry-run   # imprime lo que haría; no escribe
scripts/sync_env.sh             # aplica, con backup previo en ~/.fnharness/backups/
```

## Qué sincroniza

- `settings.json`: fusiona `hooks` (por evento, por `matcher` y por `command`, sin duplicar),
  `permissions` (unión de `allow`/`deny`/`ask`; `defaultMode` propio manda), `env` (las claves propias
  mandan; se excluyen `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` y
  `ANTHROPIC_API_KEY`), `enabledPlugins` y `language` (solo si falta). No toca `statusLine`, `model` ni
  `skipDangerousModePermissionPrompt`.
- `.claude.json`: solo `mcpServers` del nivel usuario. Gana el origen salvo que el servidor de
  fnharness lleve `"fnharnessOwn": true`; los servidores propios que no existen en el origen se
  conservan. El fichero se escribe con permisos 0600 y el informe solo muestra nombres de servidor.
- Enlaces: `hooks/`, `commands/`, `agents/` y `CLAUDE.md` hacia la ruta real (`readlink -f`) de
  `~/.claude`, solo si faltan. `.credentials.json` no se toca.

## Tests

```
bash scripts/sync_env.test.sh      # 22 comprobaciones sobre un HOME temporal
bun run test:unit                  # incluye el envoltorio scripts/sync_env.test.ts
```

## Compatibilidad de los hooks del dueño bajo `CLAUDE_CONFIG_DIR=~/.fnharness`

Los comandos se registran con `~/.claude/hooks/...` literal, así que el shell los resuelve a la
carpeta de Claude Code aunque `CLAUDE_CONFIG_DIR` apunte a fnharness; mientras `~/.claude` exista, se
encuentran. El problema es el estado que cada hook lee o escribe.

| Hook | Evento | Rutas o variables que asume | Bajo fnharness |
|---|---|---|---|
| `caveman_activate.js` | SessionStart | Usa `CLAUDE_CONFIG_DIR` con respaldo `~/.claude` para el flag `.caveman-active` | Compatible: escribe `~/.fnharness/.caveman-active`; el modo caveman queda separado del de Claude Code |
| `caveman_mode_tracker.js` | UserPromptSubmit | Igual, `CLAUDE_CONFIG_DIR` con respaldo | Compatible, mismo flag propio de fnharness |
| `goal_tracker.sh` | UserPromptSubmit | `~/.claude/goals/<sid>.json` fijo (`$HOME/.claude`), lanza `~/.claude/hooks/goal_autogen.sh` y carga `$FN_ROOT/.claude/scripts/lib_hook_dedup.sh` | Funciona pero comparte el estado de objetivos con Claude Code; el statusline de fnharness no lo lee. Sin fallo duro |
| `goal_notify.sh` | Notification | `~/.claude/goals/<sid>.json` fijo | Igual: lee el mismo directorio de objetivos; sin fallo duro |
| `goal_phase_eval.sh` | Stop | `~/.claude/goals/<sid>.json` y `~/.claude/hooks/goal_phase_worker.sh` fijos | Igual; el worker lee el transcript que le pasa el hook (ruta bajo `~/.fnharness/projects`), por eso conviene probarlo |
| `goal_phase_active.sh` | PostToolUse | `~/.claude/goals/<sid>.json` fijo | Igual |
| `obsidian_session_report.sh` | Stop | Configuración en `~/.claude/obsidian_reports.json`, `~/.fn_pc` y `$FN_REGISTRY_ROOT` (por defecto `~/fn_registry`) | Funciona; el informe de sesión puede asumir el transcript en `~/.claude/projects`, a verificar en la prueba real |
| `model_router.py` | PreToolUse (Agent) | No usa `~/.claude`; busca `.claude/agents/` desde el cwd hacia arriba y lee `CLAUDE_CODE_SUBAGENT_MODEL` | Compatible; la variable llega por la clave `env` que sincroniza el script |

Conclusión: ninguno falla de forma dura, porque `~/.claude` sigue existiendo. Los cuatro `goal_*`
comparten el directorio `~/.claude/goals` con Claude Code (los objetivos son del dueño, no de cada
arnés), y `goal_phase_eval.sh` y `obsidian_session_report.sh` deben comprobarse con una sesión real
porque dependen de dónde está el transcript. Los hooks no se han editado: viven en otro repo.
