# Catálogo de comandos de claude-multimodel

Este documento recoge los comandos del CLI `./cli` (versión 2.1.87), el wrapper `fnharness` y las variables `CLAUDE_MULTIMODEL_*`. Se generó leyendo `src/commands.ts`, `src/commands/*`, `src/main.tsx` y `src/services/api/openai-compat/profiles.ts`, y ejecutando de verdad `./cli --help`, `./cli <sub> --help`, `./cli <grupo> help <sub>` y `fnharness --list`. No se ejecutó nada que llame a un modelo.

Nota sobre `--help` anidado: en este build, `./cli mcp add --help` sí funciona, pero para subcomandos de segundo nivel como `./cli mcp list --help` o `./cli auth login --help` la salida a veces es la ayuda del programa raíz. La forma fiable es `./cli <grupo> help <sub>` (por ejemplo `./cli mcp help list`). Las tablas de abajo salen de esa forma.

## 1. Cómo leer la columna "Backend no-Anthropic"

Con `fnharness --account ...` (o `CLAUDE_MULTIMODEL_PROVIDER`) el harness habla con un servidor compatible con OpenAI. En ese modo `applyMultimodelEnv()` inyecta una `ANTHROPIC_API_KEY` de relleno, por lo que la sesión **no** es de suscriptor de claude.ai ni usa OAuth. Las consecuencias, deducidas del código (no se probaron contra un backend real):

- **Sí**: el comando es local o es un prompt que se envía al modelo activo; funciona con cualquier backend.
- **No (OAuth)**: declara `availability: ['claude-ai']` o exige `isClaudeAISubscriber()`; queda oculto o inactivo sin suscripción de claude.ai.
- **No (flag)**: depende de un feature flag de compilación (`feature(...)` de `bun:bundle`) o de un gate remoto (GrowthBook/Statsig, `tengu_*`). El build por defecto (`bun run build`) activa `VOICE_MODE`, `AGENT_TRIGGERS` y `MONITOR_TOOL`; `bun run build:dev:full` activa el conjunto experimental (`BRIDGE_MODE`, `CCR_REMOTE_SETUP`, `ULTRAPLAN`, etc., ver `scripts/build.ts`).
- **Parcial**: funciona, pero parte de su función necesita servicios de Anthropic (por ejemplo, consultas a la API de uso).

`login` y `logout` solo se ocultan con Bedrock, Vertex o Foundry (`isUsing3PServices`); con `fnharness` siguen apareciendo, pero iniciar sesión no cambia el backend activo.

## 2. Slash commands

El registro está en la función memoizada `COMMANDS()` de `src/commands.ts`. Además de estos comandos integrados, el CLI carga skills (carpetas de skills, bundled, de plugins) y comandos de plugins, que no se listan aquí. Hay 71 comandos integrados incondicionales, más los condicionados por flag (sección 2.9) y los internos de Anthropic (sección 2.10).

El tipo indica cómo se ejecuta: `local` (texto), `local-jsx` (interfaz Ink) o `prompt` (se expande a un prompt para el modelo).

### 2.1 Sesión y conversación

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/clear` | `/reset`, `/new` | Borra el historial y libera contexto. | local | Sí |
| `/compact [instrucciones]` | | Vacía el historial conservando un resumen; desactivable con `DISABLE_COMPACT`. | local | Sí (usa el modelo activo) |
| `/resume [id o búsqueda]` | `/continue` | Reanuda una conversación anterior. | local-jsx | Sí |
| `/rename [nombre]` | | Renombra la conversación actual. | local-jsx | Sí |
| `/branch [nombre]` | `/fork` (solo si `FORK_SUBAGENT` está apagado) | Crea una rama de la conversación en este punto. | local-jsx | Sí |
| `/rewind` | `/checkpoint` | Restaura código y/o conversación a un punto anterior. | local | Sí |
| `/export [archivo]` | | Exporta la conversación a un archivo o al portapapeles. | local-jsx | Sí |
| `/copy` | | Copia la última respuesta (o la N-ésima con `/copy N`) al portapapeles. | local-jsx | Sí |
| `/btw <pregunta>` | | Pregunta lateral sin interrumpir la conversación principal. | local-jsx | Sí |
| `/exit` | `/quit` | Sale del REPL. | local-jsx | Sí |
| `/plan [open\|descripción]` | | Activa el modo plan o muestra el plan de la sesión. | local-jsx | Sí |
| `/tasks` | `/bashes` | Lista y gestiona tareas en segundo plano. | local-jsx | Sí |
| `/diff` | | Muestra cambios sin confirmar y diffs por turno. | local-jsx | Sí |
| `/add-dir <ruta>` | | Añade un directorio de trabajo. | local-jsx | Sí |
| `/autocompact [auto\|off\|<tokens>]` | | Umbral de autocompactación de esta sesión: sin argumento muestra el estado; `off` la desactiva; `150k`/`1m` la dispara a ese número de tokens (solo puede bajar el umbral por defecto, mínimo 10k; los márgenes proporcionales de ventanas pequeñas no cambian); `auto` vuelve al valor por defecto. | local | No |
| `/cd <ruta>` | | Mueve la sesión a otro directorio conservando la conversación (cwd, raíz de proyecto, ajustes, hooks y `CLAUDE.md` se recalculan). Solo entra en directorios ya confiados. | local | No |

### 2.2 Modelo y razonamiento

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/model [modelo]` | | Cambia el modelo (la descripción muestra el actual). | local-jsx | Sí; `validateModel` no valida el id porque el backend es dueño de su catálogo |
| `/effort [low\|medium\|high\|max\|auto]` | | Nivel de esfuerzo del modelo. | local-jsx | Parcial (depende de que el backend use el parámetro) |
| `/fast [on\|off]` | | Alterna el modo rápido (solo con el modelo que lo soporte). | local-jsx | No: `availability` `claude-ai` o `console`, y se apaga con `CLAUDE_CODE_DISABLE_FAST_MODE` |
| `/advisor` | | Configura el modelo asesor (herramienta server-side). | local | No en la práctica: es una función de la API de Anthropic |
| `/output-style` | | Obsoleto, oculto; usar `/config`. | local-jsx | Sí |

### 2.3 Contexto, coste y estado

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/context` | | Visualiza el uso de contexto como cuadrícula (versión no interactiva en texto). | local-jsx / local | Sí |
| `/cost` | | Coste total y duración de la sesión; oculto para suscriptores de claude.ai. | local | Sí (visible, al no ser suscriptor) |
| `/usage` | | Límites del plan. | local-jsx | No (OAuth, `availability: claude-ai`) |
| `/extra-usage` | | Configura uso extra al alcanzar límites. | local-jsx / local | No (depende de `isExtraUsageAllowed`, cuenta Anthropic) |
| `/stats` | | Estadísticas de uso y actividad. | local-jsx | Sí (datos locales) |
| `/insights` | | Informe que analiza tus sesiones (prompt al modelo). | prompt | Sí |
| `/status` | | Versión, modelo, cuenta, conectividad de API y herramientas. | local-jsx | Sí |
| `/release-notes` | | Notas de versión. | local | Sí |
| `/rate-limit-options` | | Opciones al alcanzar el límite; oculto, uso interno. | local-jsx | No (OAuth) |
| `/passes` | | Comparte una semana gratis de Claude Code; oculto salvo elegibilidad. | local-jsx | No (cuenta Anthropic) |
| `/upgrade` | | Pasar a Max. | local-jsx | No (OAuth, `claude-ai`) |

### 2.4 Configuración e interfaz

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/config` | `/settings` | Abre el panel de configuración. | local-jsx | Sí |
| `/theme` | | Cambia el tema. | local-jsx | Sí |
| `/color <color\|default>` | | Color de la barra de prompt de la sesión. | local-jsx | Sí |
| `/vim` | | Alterna edición Vim / Normal. | local | Sí |
| `/keybindings` | | Abre o crea el archivo de atajos; activo según `isKeybindingCustomizationEnabled`. | local | Sí |
| `/statusline` | | Configura la línea de estado (prompt al modelo). | prompt | Sí |
| `/terminal-setup` | | Configura el terminal (Shift+Enter, etc.); oculto en terminales con soporte nativo. | local-jsx | Sí |
| `/permissions` | `/allowed-tools` | Reglas de permiso allow/deny de herramientas. | local-jsx | Sí |
| `/hooks` | | Configuración de hooks por evento de herramienta. | local-jsx | Sí |
| `/sandbox` | | Alterna el sandbox; oculto en plataformas sin soporte. | local-jsx | Sí |
| `/memory` | | Edita los archivos de memoria. | local-jsx | Sí |
| `/privacy-settings` | | Ajustes de privacidad. | local-jsx | No (solo `isConsumerSubscriber`) |
| `/help` | | Ayuda y comandos disponibles. | local-jsx | Sí |
| `/doctor` | | Diagnóstico de instalación y ajustes; desactivable con `DISABLE_DOCTOR_COMMAND`. | local-jsx | Sí |
| `/feedback` | `/bug` | Envía feedback. Se desactiva con Bedrock/Vertex/Foundry, `DISABLE_FEEDBACK_COMMAND`, tráfico solo esencial (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, que `fnharness` activa por defecto) o política. | local-jsx | No en la práctica con `fnharness` (tráfico no esencial desactivado) |

### 2.5 Extensiones: MCP, plugins, agentes, skills, IDE

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/mcp [enable\|disable [servidor]]` | | Gestiona servidores MCP. | local-jsx | Sí |
| `/plugin` | `/plugins`, `/marketplace` | Gestiona plugins. | local-jsx | Sí |
| `/recap` | | Resumen de una línea de dónde está la sesión (reutiliza `services/awaySummary.ts` con el modelo rápido). | local | No |
| `/reload-plugins` | | Activa los cambios pendientes de plugins en la sesión. | local | Sí |
| `/agents` | | Gestiona configuraciones de agentes. | local-jsx | Sí |
| `/skills` | | Lista las skills disponibles. | local-jsx | Sí |
| `/ide [open]` | | Integraciones con IDE y su estado. | local-jsx | Sí |
| `/chrome` | | Ajustes de Claude in Chrome (beta); no interactivo desactivado. | local-jsx | No (OAuth, `claude-ai`) |
| `/init` | | Crea un `CLAUDE.md` con documentación del código. | prompt | Sí |

### 2.6 Git, GitHub y revisión

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/review` | | Revisa un pull request. | prompt | Sí (necesita `gh`) |
| `/ultrareview` | | Revisión profunda en Claude Code web (10 a 20 min). Activo solo si el gate `tengu_review_bughunter_config` lo permite. | local-jsx | No (servicio remoto y gate) |
| `/security-review` | | Revisión de seguridad de los cambios pendientes de la rama. | prompt | Sí |
| `/pr-comments` | | Obtiene comentarios de un PR de GitHub (nombre real `pr-comments`). | prompt | Sí (necesita `gh`) |
| `/install-github-app` | | Configura GitHub Actions de Claude en un repositorio. | local-jsx | No (`availability` `claude-ai` o `console`, cuenta Anthropic) |
| `/install-slack-app` | | Instala la app de Claude en Slack. | local | No (OAuth, `claude-ai`) |

### 2.7 Móvil, escritorio y sesiones remotas

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/mobile` | `/ios`, `/android` | QR para descargar la app móvil de Claude. | local-jsx | Sí (solo muestra un QR) |
| `/desktop` | `/app` | Continúa la sesión en Claude Desktop; oculto en plataformas no soportadas. | local-jsx | No (OAuth, `claude-ai`) |
| `/session` | `/remote` | URL y QR de la sesión remota; solo en modo `--remote`. | local-jsx | No (requiere sesión remota) |
| `/remote-env` | | Entorno remoto por defecto para sesiones teleport. | local-jsx | No (suscriptor y política `allow_remote_sessions`) |
| `/login` | | Iniciar sesión (o cambiar de cuenta) en Anthropic. | local-jsx | No útil: solo gestiona cuentas Anthropic |
| `/logout` | | Cierra sesión de Anthropic. | local-jsx | No útil |
| `/voice` | | Alterna el modo voz. Compilado por defecto (`VOICE_MODE`), pero exige `claude-ai` y el gate GrowthBook de voz. | local | No (OAuth y gate) |

### 2.8 Misceláneos

| Comando | Alias | Descripción | Tipo | Backend no-Anthropic |
|---|---|---|---|---|
| `/stickers` | | Pedir pegatinas de Claude Code. | local | Sí (abre un enlace) |
| `/think-back` | | Resumen del año 2025 en Claude Code; depende del gate `tengu_thinkback`. | local-jsx | No (gate remoto) |
| `/thinkback-play` | | Reproduce la animación de think-back; oculto. | local | No (gate remoto) |
| `/files` | | Lista los archivos en contexto; solo si `USER_TYPE=ant`. | local | No (solo uso interno) |
| `/tag <nombre>` | | Etiqueta buscable de la sesión; solo `USER_TYPE=ant`. | local-jsx | No (solo uso interno) |
| `/heapdump` | | Vuelca el heap de JS en `~/Desktop`; oculto. | local | Sí |

### 2.9 Comandos condicionados por feature flag de compilación

No existen en el build por defecto (solo se activan `VOICE_MODE`, `AGENT_TRIGGERS` y `MONITOR_TOOL`, que no añaden comandos propios salvo la skill `/loop`). Las columnas indican el flag que los incluye. En este snapshot algunos archivos fuente no están en `src/commands/` (marcados), por lo que aunque se active el flag el `require` fallaría.

| Comando | Flag | Descripción | Fuente en el snapshot |
|---|---|---|---|
| `/remote-control` (alias `/rc`) | `BRIDGE_MODE` | Conecta el terminal para sesiones de control remoto. Oculto además si `isBridgeEnabled()` es falso. | `commands/bridge/` presente |
| `/web-setup` | `CCR_REMOTE_SETUP` | Configura Claude Code en la web (requiere GitHub); `availability: claude-ai`, gate `tengu_cobalt_lantern`. | `commands/remote-setup/` presente |
| `/ultraplan` | `ULTRAPLAN` | Plan avanzado en Claude Code web (10 a 30 min). | `commands/ultraplan.tsx` presente |
| `/brief` | `KAIROS` o `KAIROS_BRIEF` | Alterna el modo solo-resumen. | `commands/brief.ts` presente |
| `/assistant` | `KAIROS` | Modo asistente. | `commands/assistant/assistant.tsx` (no hay `index`) |
| `/proactive` | `PROACTIVE` o `KAIROS` | Modo proactivo. | No encontrado |
| `/fork` | `FORK_SUBAGENT` | Subagente fork (entonces `/branch` pierde el alias `fork`). | No encontrado |
| `/buddy` | `BUDDY` | Compañero. | No encontrado |
| `/peers` | `UDS_INBOX` | Mensajería entre pares por socket UDS. | No encontrado |
| `/workflows` | `WORKFLOW_SCRIPTS` | Scripts de flujo de trabajo. | No encontrado |
| `/torch` | `TORCH` | Experimental. | No encontrado |
| remote-control-server | `DAEMON` y `BRIDGE_MODE` | Servidor de control remoto. | No encontrado |
| `/force-snip` | `HISTORY_SNIP` (lista interna) | Forzar recorte de historial. | No encontrado |
| `/subscribe-pr` | `KAIROS_GITHUB_WEBHOOKS` (lista interna) | Suscripción a webhooks de PR. | No encontrado |

### 2.10 Comandos internos de Anthropic (`INTERNAL_ONLY_COMMANDS`)

Solo se registran con `USER_TYPE=ant` y sin `IS_DEMO`. En este snapshot sus `index.js` son stubs (`isEnabled: () => false`, `isHidden: true`), así que no hacen nada. Son: `backfill-sessions`, `break-cache`, `bughunter`, `commit`, `commit-push-pr`, `ctx_viz`, `good-claude`, `issue`, `init-verifiers`, `mock-limits`, `bridge-kick`, `version`, `reset-limits`, `onboarding`, `share`, `summary`, `teleport`, `ant-trace`, `perf-issue`, `env`, `oauth-refresh`, `debug-tool-call`, `agents-platform`, `autofix-pr`.

`/commit`, `/commit-push-pr`, `/init-verifiers` y `/version` tienen implementación real (tipo prompt o text), pero siguen limitados a `USER_TYPE=ant`.

### 2.11 `/loop` y herramientas de planificación (flags `AGENT_TRIGGERS` y `MONITOR_TOOL`, activos por defecto)

`/loop` es una skill empaquetada (no un comando integrado) y funciona con cualquier backend, porque todo es local. Las tareas son de sesión: se pierden al salir y las recurrentes caducan a los 7 días. `CLAUDE_CODE_DISABLE_CRON=1` desactiva todo el sistema.

| Entrada | Qué pasa |
|---|---|
| `/loop 5m <prompt>` o `/loop <prompt> every 20m` | Intervalo fijo: la skill calcula la expresión cron (los segundos suben al minuto; los pasos no limpios como `7m` se redondean y se avisa) y el modelo llama a `CronCreate`; después ejecuta el prompt una vez al momento. Unidades `s`, `m`, `h`, `d`. |
| `/loop <prompt>` (sin intervalo) | Modo dinámico: tras cada iteración el modelo elige la espera (60 a 3600 s) y llama a `ScheduleWakeup` con `prompt` (el mismo `/loop <prompt>`), `delaySeconds` y `reason`; con `stop: true` termina el bucle. Si una iteración acaba sin reprogramar se concede un único aviso de respaldo a los 20 min, y si esa tampoco reprograma el bucle termina. |
| `/loop` o `/loop 15m` | Sin prompt: se ejecuta el prompt de mantenimiento integrado (o el contenido de `.claude/loop.md`, luego `loop.md` en el directorio de configuración (`~/.fnharness` con el wrapper); máx. 25 000 bytes). Bare `/loop` es dinámico (centinela `<<autonomous-loop>>`); con intervalo es fijo y el texto de `loop.md` se copia al crear la tarea. |

Herramientas del modelo: `CronCreate`, `CronList`, `CronDelete` (cron de 5 campos en hora local, máx. 50 tareas), `ScheduleWakeup` (la espera pendiente aparece en `CronList` como tarea de un disparo) y `Monitor`.

`Monitor` lanza un comando en segundo plano y entrega cada línea de stdout al modelo como notificación `<task-notification>` con un bloque `<event>`. Parámetros: `command`, `description`, `timeout_ms` (por defecto 5 min, máx. 30), `persistent` (sin plazo) y los extras `include` y `exclude` (regex por línea). Las líneas se agrupan cada 400 ms, se limpian de ANSI, se recortan a 2000 caracteres y se limitan a 100 por ventana de 10 s (el exceso se cuenta y se avisa; un flujo desbocado se detiene). Usa las mismas reglas de permisos que Bash, aparece en la pastilla del pie como `N monitors` y se detiene con `TaskStop`. No se implementó la fuente WebSocket de Claude Code.

## 3. CLI de línea de comandos

Forma general: `claude [options] [command] [prompt]`; el binario es `./cli` (también `bin.claude` y `bin.claude-multimodel` en `package.json`). Por defecto abre una sesión interactiva; `-p/--print` imprime y sale. Versión: `./cli --version` devuelve `2.1.87 (Claude Code)`.

### 3.1 Subcomandos

| Subcomando | Alias | Descripción | Opciones propias | Backend no-Anthropic |
|---|---|---|---|---|
| `agents` | | Lista los agentes configurados. | `--setting-sources <sources>` | Sí |
| `auth login` | | Inicia sesión en Anthropic. | `--claudeai` (por defecto), `--console`, `--email <email>` | No útil |
| `auth logout` | | Cierra sesión. | | No útil |
| `auth status` | | Estado de autenticación. | `--json` (por defecto), `--text` | Sí (informa de que no hay sesión OAuth) |
| `doctor` | | Salud del auto-actualizador; omite el diálogo de confianza y lanza los servidores stdio de `.mcp.json`. | | Sí |
| `install [target]` | | Instala el build nativo (`stable`, `latest` o versión). | `--force` | Sí |
| `update` | `upgrade` | Busca e instala actualizaciones. | | Sí |
| `setup-token` | | Token de larga duración (requiere suscripción). | | No (OAuth) |
| `mcp serve` | | Arranca el servidor MCP de Claude Code. | `-d, --debug`, `--verbose` | Sí |
| `mcp add <name> <commandOrUrl> [args...]` | | Añade un servidor MCP. | `-s, --scope <local\|user\|project>` (por defecto `local`), `-t, --transport <stdio\|sse\|http>`, `-e, --env <env...>`, `-H, --header <header...>`, `--callback-port <port>`, `--client-id <id>`, `--client-secret` | Sí |
| `mcp add-json <name> <json>` | | Añade un servidor stdio o SSE desde JSON. | `-s, --scope`, `--client-secret` | Sí |
| `mcp add-from-claude-desktop` | | Importa servidores de Claude Desktop (solo Mac y WSL). | `-s, --scope` | Sí |
| `mcp get <name>` | | Detalles de un servidor MCP. | | Sí |
| `mcp list` | | Lista los servidores MCP configurados. | | Sí |
| `mcp remove <name>` | | Elimina un servidor MCP. | `-s, --scope` | Sí |
| `mcp reset-project-choices` | | Reinicia las aprobaciones de servidores de `.mcp.json`. | | Sí |
| `plugin` | `plugins` | Gestiona plugins (subcomandos abajo). | | Sí |
| `plugin install <plugin>` | `i` | Instala (`plugin@marketplace` para fijar marketplace). | `-s, --scope <user\|project\|local>` (por defecto `user`) | Sí |
| `plugin uninstall <plugin>` | `remove`, `rm` | Desinstala. | `-s, --scope`, `--keep-data` | Sí |
| `plugin enable <plugin>` | | Activa un plugin. | `-s, --scope` | Sí |
| `plugin disable [plugin]` | | Desactiva un plugin. | `-a, --all`, `-s, --scope` | Sí |
| `plugin update <plugin>` | | Actualiza (requiere reinicio). | `-s, --scope <user\|project\|local\|managed>` | Sí |
| `plugin list` | | Lista los instalados. | `--json`, `--available` (requiere `--json`) | Sí |
| `plugin validate <path>` | | Valida un manifiesto de plugin o marketplace. | | Sí |
| `plugin marketplace add <source>` | | Añade un marketplace (URL, ruta o repo de GitHub). | `--scope <user\|project\|local>`, `--sparse <paths...>` | Sí |
| `plugin marketplace list` | | Lista los marketplaces. | `--json` | Sí |
| `plugin marketplace remove <name>` | `rm` | Elimina un marketplace. | | Sí |
| `plugin marketplace update [name]` | | Actualiza uno o todos. | | Sí |

Subcomandos que existen en `src/main.tsx` pero no aparecen en el `--help` del build por defecto, porque dependen de flags o de `USER_TYPE=ant`: `server`, `ssh <host> [dir]`, `open <cc-url>`, `auto-mode` (`defaults`, `config`, `critique`), `remote-control`, `assistant [sessionId]`, `up`, `rollback`, `log`, `error`, `export`, `task` (`create`, `list`, `get`, `update`, `dir`). No se pudieron ejecutar.

### 3.2 Opciones globales

Salida literal de `./cli --help` (49 opciones). Además de ellas existen opciones ocultas (`--task-budget`, `--sdk-url`, `--teleport`, `--remote`, `--agent-id`, `--team-name`, etc.) y otras bajo flag (`--proactive`, `--brief`, `--channels`, `--remote-control`).

Sesión y entrada/salida:

| Opción | Descripción |
|---|---|
| `[prompt]` | Prompt inicial (argumento). |
| `-p, --print` | Imprime la respuesta y sale (útil en tuberías). Omite el diálogo de confianza del espacio de trabajo. |
| `--output-format <text\|json\|stream-json>` | Formato de salida (solo con `--print`). |
| `--input-format <text\|stream-json>` | Formato de entrada (solo con `--print`). |
| `--include-partial-messages` | Incluye fragmentos parciales (con `--print` y `stream-json`). |
| `--include-hook-events` | Incluye eventos del ciclo de vida de hooks (con `stream-json`). |
| `--replay-user-messages` | Reemite los mensajes de usuario recibidos por stdin. |
| `--json-schema <schema>` | Esquema JSON para validar la salida estructurada. |
| `--max-budget-usd <amount>` | Gasto máximo en llamadas a la API (solo `--print`). |
| `--fallback-model <model>` | Modelo de reserva si el principal está saturado (solo `--print`). |
| `--no-session-persistence` | No guarda la sesión en disco (solo `--print`). |
| `-c, --continue` | Continúa la conversación más reciente del directorio. |
| `-r, --resume [value]` | Reanuda por ID o con selector interactivo. |
| `--fork-session` | Al reanudar, crea un ID de sesión nuevo. |
| `--from-pr [value]` | Reanuda una sesión vinculada a un PR. |
| `--session-id <uuid>` | Usa un ID de sesión concreto. |
| `-n, --name <name>` | Nombre visible de la sesión. |
| `-w, --worktree [name]` | Crea un git worktree para la sesión. |
| `--tmux` | Crea una sesión tmux para el worktree (requiere `--worktree`). |

Modelo y prompts:

| Opción | Descripción |
|---|---|
| `--model <model>` | Modelo de la sesión (alias o nombre completo). Con `fnharness` se prefiere `CLAUDE_MULTIMODEL_MODEL`. |
| `--effort <low\|medium\|high\|max>` | Nivel de esfuerzo. |
| `--agent <agent>` | Agente de la sesión. |
| `--agents <json>` | Define agentes personalizados en JSON. |
| `--system-prompt <prompt>` | Prompt de sistema. |
| `--append-system-prompt <prompt>` | Añade al prompt de sistema por defecto. |
| `--betas <betas...>` | Cabeceras beta (solo con clave de API). |

Permisos y herramientas:

| Opción | Descripción |
|---|---|
| `--permission-mode <acceptEdits\|bypassPermissions\|default\|dontAsk\|plan>` | Modo de permisos. |
| `--dangerously-skip-permissions` | Salta todas las comprobaciones de permisos; solo en sandboxes sin Internet. |
| `--allow-dangerously-skip-permissions` | Habilita la opción de saltar permisos sin activarla por defecto. |
| `--allowedTools, --allowed-tools <tools...>` | Herramientas permitidas (ej. `"Bash(git:*) Edit"`). |
| `--disallowedTools, --disallowed-tools <tools...>` | Herramientas denegadas. |
| `--tools <tools...>` | Conjunto de herramientas incorporadas (`""` las desactiva, `default` todas). |
| `--add-dir <directories...>` | Directorios adicionales con acceso. |
| `--disable-slash-commands` | Desactiva todas las skills. |

Configuración, MCP y plugins:

| Opción | Descripción |
|---|---|
| `--settings <file-or-json>` | Ajustes adicionales (ruta o JSON). |
| `--setting-sources <sources>` | Orígenes de ajustes (`user`, `project`, `local`). |
| `--mcp-config <configs...>` | Carga servidores MCP desde archivos o cadenas. |
| `--strict-mcp-config` | Solo usa los de `--mcp-config`. |
| `--plugin-dir <path>` | Carga plugins de un directorio solo para esta sesión (repetible). |
| `--bare` | Modo mínimo (sin hooks, LSP, sincronización de plugins, memoria automática, lecturas de llavero ni autodescubrimiento de `CLAUDE.md`); fija `CLAUDE_CODE_SIMPLE=1`. |
| `--autocompact <auto\|off\|tokens>` | Umbral de autocompactación para la sesión (igual que `/autocompact`). |
| `--safe-mode` | Arranque de diagnóstico: sin `CLAUDE.md`, skills, hooks, MCP (ni `--mcp-config`) ni plugins (ni `--plugin-dir`); la autenticación y el resto no cambian. Fija `FNHARNESS_SAFE_MODE=1`. |
| `--file <specs...>` | Archivos a descargar al inicio (`file_id:ruta`). |

Integraciones y depuración:

| Opción | Descripción |
|---|---|
| `--chrome` / `--no-chrome` | Activa o desactiva la integración con Claude in Chrome (necesita claude.ai). |
| `--ide` | Conecta con el IDE si hay exactamente uno disponible. |
| `-d, --debug [filter]` | Modo depuración con filtro de categorías. |
| `--debug-file <path>` | Escribe el log de depuración en un archivo. |
| `--mcp-debug` | Obsoleto; usar `--debug`. |
| `--verbose` | Sobrescribe el modo detallado. |
| `-v, --version` | Muestra la versión. |
| `-h, --help` | Ayuda. |

### 3.3 Flags especiales procesados antes de commander (`src/entrypoints/cli.tsx`)

`--version`/`-v`/`-V` (respuesta rápida), `--update`/`--upgrade`, `--claude-in-chrome-mcp`, `--chrome-native-host`, y bajo flag de compilación `--dump-system-prompt`, `--computer-use-mcp`, `--daemon-worker`. No se ejecutaron los de servidor.

## 4. El wrapper `fnharness`

`fnharness` es un script bash que traduce flags a variables `CLAUDE_MULTIMODEL_*`, y luego hace `exec ./cli "$@"`. Todo lo que no reconoce (por ejemplo `-p`) pasa tal cual al CLI. Falla con un mensaje si `./cli` no existe (`bun run build`). Los flags de `mm` solo se interpretan al principio de la línea: en cuanto aparece un argumento desconocido, el resto va al CLI.

| Flag de `fnharness` | Variable que fija | Descripción |
|---|---|---|
| `--account <nombre>` | `CLAUDE_MULTIMODEL_PROVIDER` | Preset de backend. |
| `--model <id>` | `CLAUDE_MULTIMODEL_MODEL` | Modelo principal enviado al backend. |
| `--small-model <id>` | `CLAUDE_MULTIMODEL_SMALL_MODEL` | Modelo para llamadas baratas o de fondo. |
| `--base-url <url>` | `CLAUDE_MULTIMODEL_BASE_URL` | Sobrescribe la URL del preset. |
| `--api-key <clave>` | `CLAUDE_MULTIMODEL_API_KEY` | Sobrescribe la clave (aparecerá en la lista de procesos; mejor exportar la variable). |
| `--list` | | Lista los presets leyendo `profiles.ts`; sale sin ejecutar el CLI. |
| `-h, --help` | | Imprime el uso (líneas 2 a 9 del script). |

Ejemplos:

```bash
fnharness --account ollama --model qwen3:8b             # sesión interactiva
fnharness --account llamacpp -p "resume este repo"      # una sola pasada
fnharness --list
```

Salida real de `fnharness --list`: `ollama`, `llamacpp`, `lmstudio`, `openai`, `openrouter`, `groq`, `deepseek`, `gemini`, `mistral`, `together`, `custom`.

### 4.1 Presets (`PROVIDER_PRESETS`)

| Preset | URL base | Variable de clave | Clave opcional | Modelo por defecto | Parámetro de tokens |
|---|---|---|---|---|---|
| `ollama` | `http://localhost:11434/v1` | | Sí | `qwen3:8b` | `max_tokens` |
| `llamacpp` | `http://localhost:8082/v1` | | Sí | `default` | `max_tokens` |
| `lmstudio` | `http://localhost:1234/v1` | | Sí | `default` | `max_tokens` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | No | `gpt-4.1` | `max_completion_tokens` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | No | `anthropic/claude-sonnet-4.5` | `max_tokens` |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | No | `llama-3.3-70b-versatile` | `max_tokens` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | No | `deepseek-chat` | `max_tokens` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` | No | `gemini-2.5-pro` | `max_tokens` |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | No | `mistral-large-latest` | `max_tokens` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | No | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | `max_tokens` |
| `custom` | (vacía; obliga a `CLAUDE_MULTIMODEL_BASE_URL`) | | Sí | `default` | `max_tokens` |

## 5. Variables `CLAUDE_MULTIMODEL_*`

Definidas en `src/services/api/openai-compat/profiles.ts` y resueltas por `resolveProfile(env)`. Sin `CLAUDE_MULTIMODEL_PROVIDER` el harness habla con Anthropic como siempre.

| Variable | Obligatoria | Efecto |
|---|---|---|
| `CLAUDE_MULTIMODEL_PROVIDER` | Sí, para activar el modo | Nombre del preset (sin distinguir mayúsculas) o `custom`. Un nombre desconocido aborta con la lista de disponibles. |
| `CLAUDE_MULTIMODEL_BASE_URL` | Solo con `custom` | Sustituye la URL del preset; se le quitan las barras finales. |
| `CLAUDE_MULTIMODEL_API_KEY` | Si el preset exige clave y no hay su variable propia | Tiene prioridad sobre la variable del preset (por ejemplo `OPENAI_API_KEY`). Si falta una clave obligatoria el arranque termina con error claro. |
| `CLAUDE_MULTIMODEL_MODEL` | No | Modelo principal; por defecto el del preset. |
| `CLAUDE_MULTIMODEL_SMALL_MODEL` | No | Modelo de llamadas de fondo; por defecto el mismo que el principal. |

Un error de configuración se imprime como `claude-multimodel: <mensaje>` y sale con código 1. Efectos de `applyMultimodelEnv()` al activarse un perfil (se ejecuta al inicio de `src/entrypoints/cli.tsx`):

- `ANTHROPIC_MODEL` y `ANTHROPIC_DEFAULT_OPUS_MODEL` y `ANTHROPIC_DEFAULT_SONNET_MODEL` = modelo principal.
- `ANTHROPIC_SMALL_FAST_MODEL` y `ANTHROPIC_DEFAULT_HAIKU_MODEL` = modelo pequeño.
- `ANTHROPIC_API_KEY` = `claude-multimodel-placeholder` si no estaba definida (evita el login de claude.ai; el adaptador la ignora).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` y `DISABLE_TELEMETRY=1` si no estaban definidas.

Otros puntos de integración: `src/services/api/client.ts` enruta las peticiones por el adaptador OpenAI-compatible, `validateModel.ts` omite la validación de modelos y `logoV2Utils.ts` muestra el preset y la URL en la cabecera.

## 6. Lo que no se pudo verificar

- Qué slash commands aparecen en una sesión interactiva real: es una TUI y no se abrió (se evitó cualquier llamada a un modelo). La columna "Backend no-Anthropic" se deduce de `availability`, `isEnabled` y `isHidden` en el código, no de una ejecución con un backend.
- Los gates remotos (`tengu_*`, GrowthBook, Statsig) y las políticas organizativas no pueden evaluarse sin cuenta Anthropic.
- Los subcomandos bajo flag o `USER_TYPE=ant` (sección 3.1) y los slash commands marcados "No encontrado" (sección 2.9): su fuente no está en este snapshot.
