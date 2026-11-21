# Catálogo de comandos de claude-multimodel

Este documento recoge los comandos del CLI `./cli` (versión 2.1.87), el wrapper `fnharness` y las variables `CLAUDE_MULTIMODEL_*`. Se generó leyendo `src/commands.ts`, `src/commands/*`, `src/main.tsx` y `src/services/api/openai-compat/profiles.ts`, y ejecutando de verdad `./cli --help`, `./cli <sub> --help`, `./cli <grupo> help <sub>` y `fnharness --list`. No se ejecutó nada que llame a un modelo.

Nota sobre `--help` anidado: en este build, `./cli mcp add --help` sí funciona, pero para subcomandos de segundo nivel como `./cli mcp list --help` o `./cli auth login --help` la salida a veces es la ayuda del programa raíz. La forma fiable es `./cli <grupo> help <sub>` (por ejemplo `./cli mcp help list`). Las tablas de abajo salen de esa forma.

## 1. Cómo leer la columna "Backend no-Anthropic"

Cuenta de arranque: `--account` > `default` (`/account default <id> [modelo]`, `fnharness --set-default`) > última usada > `claude`.

Con `fnharness --account ...` (o `CLAUDE_MULTIMODEL_PROVIDER`) el harness habla con un servidor compatible con OpenAI. En ese modo `applyMultimodelEnv()` inyecta una `ANTHROPIC_API_KEY` de relleno, por lo que la sesión **no** es de suscriptor de claude.ai ni usa OAuth. Las consecuencias, deducidas del código (no se probaron contra un backend real):

- **Sí**: el comando es local o es un prompt que se envía al modelo activo; funciona con cualquier backend.
- **No (OAuth)**: declara `availability: ['claude-ai']` o exige `isClaudeAISubscriber()`; queda oculto o inactivo sin suscripción de claude.ai.
- **No (flag)**: depende de un feature flag de compilación (`feature(...)` de `bun:bundle`) o de un gate remoto (GrowthBook/Statsig, `tengu_*`). El build por defecto (`bun run build`) activa `VOICE_MODE`, `AGENT_TRIGGERS` y `MONITOR_TOOL`; `bun run build:dev:full` activa el conjunto experimental (`BRIDGE_MODE`, `CCR_REMOTE_SETUP`, `ULTRAPLAN`, etc., ver `scripts/build.ts`).
- **Parcial**: funciona, pero parte de su función necesita servicios de Anthropic (por ejemplo, consultas a la API de uso).

`login` y `logout` solo se ocultan con Bedrock, Vertex o Foundry (`isUsing3PServices`); con `fnharness` siguen apareciendo, pero iniciar sesión no cambia el backend activo.

### 2.12c Selector de sesiones (`/sesiones` y la flecha ←)

El selector junta las sesiones de toda la máquina: las de fnharness y las de Claude Code (`<config>/sessions/<pid>.json` de `~/.fnharness`, `~/.claude` y `~/.claude-work`), las bg, las salas de Element sobre tmux (`~/.local/state/matrix_terminals`, o `MATRIX_TERMINALS_STATE_DIR`) y las ventanas de kitty (`/tmp/kitty-*`, o `FNHARNESS_KITTY_SOCKET_DIR`). Cada sesión sale con su origen (`kitty`, `tmux`, `element`, `head`, `bg`, `rec`), estado, título, directorio, cuenta y edad.

| Entrada | Qué pasa |
|---|---|
| `←` con el prompt vacío | Abre el selector. Con texto en el prompt la flecha mueve el cursor como siempre. Se puede reasignar con la acción `chat:agentsView`. |
| `ctrl+x ctrl+w` | Abre el selector también con texto en el prompt (acción `chat:sessionSwitcher`). |
| Escribir | Filtra por palabras (todas deben aparecer en título, directorio, `cuenta:modelo`, origen o agente). |
| `↑`/`↓`, `Enter` | Salta con la acción por defecto de la fila: enfoca la ventana de kitty, adjunta el tmux (Element y sesiones en tmux; `Ctrl+B d` vuelve) o abre el detalle si hay que reanudar. |
| `→` | Detalle: datos, últimas líneas de la conversación y todas las acciones (enfocar, adjuntar, reanudar, bifurcar, enviar mensaje, parar una bg). `←` vuelve. |
| `Esc` | Borra el filtro; con el filtro vacío, cierra. |
| `/sesiones [list] [--json] [--todas]` | Lista en texto o JSON (una fila por sesión, sin duplicados); `--todas` añade las conversaciones de Element suspendidas. |

Reglas: una sesión viva nunca se reanuda sobre su propio transcript (dos procesos escribirían el mismo `.jsonl`): solo se ofrece "Bifurcar aquí" (`--resume <sid> --fork-session`). Reanudar o bifurcar aquí cierra esta sesión y pide al lanzador `bin/fnharness` que relance el CLI en el directorio de la otra (`--chdir`); con `./cli` directo se muestra el comando a mano. Una conversación de `claude` no se reanuda en fnharness. Adjuntar a Element escribe en la misma TUI que el puente de Matrix, con `-f ignore-size`. Código: `src/utils/sessionDirectory/` (puro: `merge`, `origin`, `actions`, `rows`; impuro: `sources`, `jump/*`) y `src/components/sessions/`. Plan y estado: `docs/plans/session_switcher.md`.

## 2. Slash commands

El registro está en la función memoizada `COMMANDS()` de `src/commands.ts`. Además de estos comandos integrados, el CLI carga skills (carpetas de skills, bundled, de plugins) y comandos de plugins, que no se listan aquí. Hay 72 comandos integrados incondicionales, más los condicionados por flag (sección 2.9) y los internos de Anthropic (sección 2.10).

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
| `/model [modelo \| cuenta:modelo]` | | Sin argumento abre un selector con los modelos de **todas** las cuentas conectadas, agrupados por cuenta con cabecera (como `/account`) y filtrables escribiendo; elegir uno de otra cuenta cambia la sesión a esa cuenta y modelo de una vez (pasa por `PreModelSwitch`/`PostModelSwitch` y recuerda el modelo para esa cuenta, igual que `/account <id> <modelo>`). `/model cuenta:modelo` hace lo mismo por argumento (`/model claude:opus`, `/model qwen36:qwen36-35b-heretic-q4km`); sin prefijo de cuenta, o con el de la cuenta activa, solo cambia el modelo. El esfuerzo se ajusta con `/effort`. | local-jsx | Sí; `validateModel` no valida el id porque el backend es dueño de su catálogo |
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
| `/mcp [reload [servidor] \| reconnect <servidor\|all> \| enable\|disable [servidor]]` | | Gestiona servidores MCP. `reload` relee `.mcp.json`, `.claude.json` y settings y aplica solo la diferencia (añade, reconecta lo cambiado, desconecta lo eliminado); con nombre fuerza además la reconexión de ese servidor. `reconnect all` reintenta los que están `failed`, `needs-auth` o `pending`. Un JSON roto aborta la recarga sin tocar nada. | local-jsx | Sí |
| `/plugin` | `/plugins`, `/marketplace` | Gestiona plugins. | local-jsx | Sí |
| `/recap` | | Resumen de una línea de dónde está la sesión (reutiliza `services/awaySummary.ts` con el modelo rápido). | local | No |
| `/reload-skills` | | Reescanea los directorios de skills sin reiniciar y dice cuáles son nuevas o han desaparecido; el menú de `/` se refresca. | local | No |
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
| `/logout [<id> [--yes]]` | | Sin argumento cierra la sesión de la cuenta `claude` (credenciales de la raíz), como siempre. Con `<id>` cierra solo esa cuenta Claude añadida: pide confirmación y borra `accounts/<id>/` y su entrada en `accounts.json` (sección 2.16). | local-jsx | No útil |
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
| `/peers` | `UDS_INBOX` (activo por defecto) | Lista las otras sesiones de la máquina (pid, sesión, estado, cwd, dirección) o envía un mensaje: `/peers send <pid\|sesión\|nombre\|parent> <mensaje>`. | `commands/peers/` |
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

### 2.12 `/goal`

Comando integrado (tipo `local-jsx`, disponible también en `-p`). Mantiene al agente trabajando turno tras turno hasta que un evaluador confirma que la condición se cumple o es imposible. Funciona con cualquier cuenta.

| Entrada | Qué pasa |
|---|---|
| `/goal <condición> [--judge <cuenta>] [--turns N]` | Fija el objetivo de la sesión y arranca el trabajo con un mensaje meta. Tras cada turno del agente (cuando se dispararía el hook Stop) el evaluador recibe la condición y el final de la conversación y responde `met`, `not_met` o `impossible`. Con `not_met` se le devuelve su motivo al agente y sigue. |
| `/goal` | Muestra el estado: condición, turnos, tiempo, tokens, evaluador y último veredicto. |
| `/goal clear` (también `off`, `stop`, `cancel`) | Quita el objetivo. |

Reglas de parada: condición cumplida; evaluador dice imposible; 3 turnos seguidos sin ninguna llamada a herramienta; tope de turnos (30 por defecto, `--turns`); fallo del evaluador. Al parar se escribe un mensaje de resumen y el objetivo se descarta. Tras cada turno se muestra una línea `◎ /goal · turno 2/30 · 1m 12s · 8.4k tokens · <condición>` como mensaje de sistema y como notificación del pie. Los tokens suman agente y evaluador.

Evaluador: por defecto la cuenta y el modelo pequeño activos. Los modelos locales pequeños juzgan mal, así que se puede fijar otra cuenta con `--judge claude` (modelo rápido de Anthropic), con la variable `FNHARNESS_GOAL_JUDGE` o con el ajuste `goalJudge` de `settings.json`; el orden de prioridad es ese. Para llamar al evaluador se cambia de cuenta un instante y se restaura al terminar. El objetivo vive en memoria: no sobrevive a un reinicio. Código: `src/utils/goal/` (lógica pura en `goalLogic.ts`, estado y juez en `goalState.ts`), `src/commands/goal/` y el gancho en `src/query/stopHooks.ts`.

### 2.12b Sesiones en segundo plano (`/background` y `fnharness ps|logs|stop|attach|rm`)

Una sesión en segundo plano es una ejecución headless (`-p --output-format stream-json`) de este mismo binario, en su propio grupo de procesos, sin tmux ni demonio. El estado vive en `<CLAUDE_CONFIG_DIR>/bg/<id>/` (`meta.json`, `events.jsonl`, `stderr.log`, `exit`).

| Entrada | Qué pasa |
|---|---|
| `fnharness --bg "<prompt>" [flags]` | Lanza la sesión y escribe su id de 8 caracteres. Los flags (`--model`, `--permission-mode`...) se reenvían; `--account` lo gestiona el lanzador. |
| `fnharness ps` | Tabla con id, cuenta, estado (`running`, `done`, `failed`, `stopped`, `lost`), inicio y prompt corto. |
| `fnharness logs <id> [-f]` | Salida legible de la sesión; con `-f` la sigue hasta que termina. El id admite prefijo. |
| `fnharness stop <id>` (también `kill`) | SIGTERM al grupo y SIGKILL si no cae. |
| `fnharness attach <id>` | Terminada: la reanuda en la TUI con `--resume` (mismo directorio y cuenta). Viva: sigue sus logs, no hay toma en vivo (límite v1). |
| `fnharness rm <id>` | Borra el registro de una sesión parada (el transcript se conserva). |
| `/background <prompt>` (`/bg`) | Desde la TUI, lanza una sesión que bifurca la conversación actual (`--resume --fork-session`) y trabaja en el prompt. No desvincula la TUI. |

Una sesión headless no puede contestar permisos: usa el modo de permisos de quien la lanza (el lanzador `fnharness` arranca en bypass). Código: `src/cli/bgCore.ts` (lógica pura, tests en `bgCore.test.ts`), `src/cli/bg.ts` y `src/commands/background/`.

### 2.13 `/scope` (perfil de contexto)

Comando integrado (tipo `local-jsx`). Decide qué entra al modelo en cada petición; pensado para modelos locales con poca ventana. Se aplica desde el siguiente turno y se recuerda por cuenta (`contextProfile` en `accounts.json`; para `claude`, en `.claude.json`). Por defecto: `claude` y cuentas remotas → Full; backends locales (qwen36, llamacpp, ollama, ...) → Simple. Al cambiar de cuenta con `/account` se carga el perfil de esa cuenta.

| Entrada | Qué pasa |
|---|---|
| `/scope` | Estado y selector de presets con el coste estimado de cada uno (sistema, tools, skills). |
| `/scope full\|folder\|user\|simple\|nothing` | Aplica un preset (alias: `todo`, `carpeta`, `usuario`, `nada`, `chat`). |
| `/scope mcp:<full\|folder\|user\|none> skill:<full\|folder\|user\|none> tools:<full\|simple\|none>` | Cambia ejes sueltos sobre el perfil actual; un preset delante hace de base. |
| Ctrl+Tab / Ctrl+Shift+Tab | Rota Full → Folder → User → Simple → Nothing (acciones `chat:cycleContextProfile` y `chat:cycleContextProfileBack`). |

Ejes: `mcp` filtra servidores por el `scope` de su config (`folder` = project/local, `user` = user); `skill` filtra lo que ve el modelo por origen (`folder` = `.claude` del proyecto, `user` = `~/.claude`; con `none` no se envía `SkillTool`); `tools` deja todas las integradas, solo Bash/Read/Write/Edit/Glob/Grep (`simple`) o ninguna (`none`, con un prompt de sistema corto de chat). El pie muestra `ctx: <perfil> ~Nk tok`. `FNHARNESS_CONTEXT_PROFILE` fuerza el perfil al arrancar sin tocar lo guardado. Diseño y medidas: `docs/plans/context_profile.md`.

### 2.14 `/perfil` (perfiles de contexto)

Comando integrado (tipo `local-jsx`). Un perfil agrupa con un nombre el system prompt, las herramientas y qué contexto llega al modelo (CLAUDE.md, memoria, hooks, MCP, skills), más una cuenta y un modelo opcionales. Es una capa encima de `/scope`: el perfil se traduce a un scope (con listas exactas de herramientas y de servidores MCP) y el resto de ejes se aplican con las variables de entorno que ya miran CLAUDE.md, la memoria y los hooks.

| Entrada | Qué pasa |
|---|---|
| `/perfil` | Selector de perfiles con descripción y coste aproximado en tokens (sistema, tools, skills, CLAUDE.md). |
| `/perfil <nombre>` | Aplica el perfil desde el siguiente turno. Si trae `account`, cambia de cuenta antes. Si no se puede en caliente, avisa y reinicia la sesión. |
| `/perfil nuevo <nombre>` | Escribe `<CLAUDE_CONFIG_DIR>/profiles/<nombre>.json` con lo que tiene la sesión ahora y muestra la ruta. No pisa un fichero existente. |
| `fnharness --perfil <nombre>` | Arranca con ese perfil. Resolución: `--perfil` > `FNHARNESS_PROFILE` > `default` > `active` de `profiles.json`. Sin ninguno manda el scope recordado por cuenta. |

Formato (JSON en `<CLAUDE_CONFIG_DIR>/profiles/<nombre>.json`; el del usuario sustituye al de fábrica del mismo nombre):

```json
{ "description": "8B local, 16k",
  "systemPrompt": { "mode": "default|replace|append", "text": "...", "file": "ruta relativa a profiles/" },
  "tools": "default" | ["Read","Write","Edit","Glob"],
  "context": { "bare": false, "claudeMd": true, "memory": true, "hooks": true, "mcp": true | ["registry"], "skills": true },
  "account": "opcional", "model": "opcional" }
```

`replace` y `append` exigen `text` o `file`. `bare: true` fuerza `claudeMd`, `memory` y `hooks` a false. En `text` (y en el fichero) `{cwd}` se sustituye por el directorio de trabajo: un prompt de reemplazo no lleva la información de entorno y un modelo pequeño que no sabe dónde está inventa rutas. Perfiles de fábrica (`src/config/defaults/perfiles/`): `full` (todo por defecto), `simple` (Read, Write, Edit, Glob, Grep, Bash; sin MCP, memoria ni hooks) y `minimo` (bare, Read, Write, Edit, Glob, prompt de una línea, para un modelo local de 8B con 16k de contexto), y `chat` (bare, solo `SendMessage`, prompt de pocas frases, para modelos locales muy pequeños que conversan con otros agentes). `exactTools: true` (solo con `bare` y una lista en `tools`) hace exacta la lista: sin él el modo bare ofrece siempre Bash, Read y Edit y la lista solo añade. El estado va en `<CLAUDE_CONFIG_DIR>/profiles.json` (`{default, active}`, 0600; `/perfil <n>` fija `active`).

En caliente (desde el siguiente turno): herramientas, MCP (todos, ninguno o una lista), skills, system prompt (un `--system-prompt` explícito gana al del perfil; `append` se suma detrás), memoria y CLAUDE.md. Con reinicio: cambiar `bare` en cualquier sentido y pasar los hooks de apagados a encendidos. El reinicio lo hace el lanzador: el CLI escribe `restart/<pid del lanzador>.args` y sale con 75, y `bin/fnharness` relanza con `--resume <sesión> --perfil <x>` conservando `--account` y `--model`. Con `-p`, con `FNHARNESS_NO_RESTART=1` o ejecutando `./cli` directamente no hay bucle: `/perfil` imprime el comando a escribir. El modelo de un perfil solo se aplica con su cuenta; un perfil con `account` bare añade a Bash/Read/Edit las herramientas que nombra. `/scope` y Ctrl+Tab ajustan el scope encima y marcan el perfil como modificado (`nombre*` en la barra de estado). `/account` ya no pisa el scope de un perfil activo.

### 2.15 `/otel` y `/telemetry` (telemetría OpenTelemetry por cuenta)

Telemetría OTLP real, con receptores ligados a cuentas. Comando integrado (tipo `local`, funciona también con `-p "/otel"`). Alias: `/opentelemetry` y `/telemetry`.

**Qué se envía y a dónde.** Cada medición pertenece a una cuenta: la que sirvió la petición (el ámbito de `claude-work:sonnet`, por ejemplo) o, fuera de un ámbito, la de la sesión. `sinksFor(cuenta)` decide qué receptores la ven:

- receptor **de una organización** (`managed`): sale de los `OTEL_*` de las remote-settings de una cuenta Claude (p. ej. Datadog EU de `claude-work`). Solo recibe las mediciones de esa cuenta, siempre con el esquema `official` (el de Claude Code, sin atributos `fnharness.*`) y con lo que dicte su organización (intervalos, `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_METRICS_INCLUDE_*`). Solo la organización lo apaga;
- receptor **propio** (`user`): declarado en `<CLAUDE_CONFIG_DIR>/telemetry.json` (0600) con una lista **explícita** de cuentas (`"*"` incluiría también las cuentas de empresa, por eso no se usa). Esquema `official` o `enriched` (añade `fnharness.account`, `fnharness.account_kind`, `fnharness.backend`, `fnharness.routed`, `fnharness.session_account`, `agent.type`, `pc` y `session.id`). Prompts redactados y detalle de herramientas apagado salvo `logUserPrompts`/`logToolDetails` en ese receptor;
- las métricas de sesión (`session.count`, `active_time`, `lines_of_code`, `commit`, `pull_request`, `code_edit_tool.decision`) van solo a los receptores de la cuenta de la **sesión**, aunque un subagente corra en otra cuenta; coste, tokens y eventos van a los de la cuenta que sirvió la petición;
- la identidad (`user.email`, `organization.id`, `user.account_uuid`) es la de la cuenta que sirvió la petición: un receptor nunca ve la identidad de otra cuenta;
- `DISABLE_TELEMETRY` puesto por la persona apaga los receptores propios, no los de una organización. Una cuenta OpenAI-compatible ya no pone `DISABLE_TELEMETRY`: pone `FNHARNESS_PROFILE_NO_TELEMETRY=1`, que solo mantiene apagada la analítica no esencial del proveedor;
- el entorno del proceso (`OTEL_*` en el shell) no crea receptores; las trazas no se envían.

Ejemplo de `telemetry.json`:

```json
{
  "sinks": {
    "otel-3amdata": {
      "endpoint": "https://otel.3amdata.win",
      "protocol": "http/json",
      "headersRef": "pass:ionos/otel-token",
      "headersAs": "bearer",
      "accounts": ["claude", "qwen36", "ollama", "zcode", "venice"],
      "schema": "enriched",
      "logUserPrompts": false,
      "logToolDetails": false,
      "metricsIntervalMs": 60000
    }
  }
}
```

`headersRef` es una referencia del gestor de secretos (`pass:`, `env:`, `file:`, `keyring:`, `cmd:`, ver `/secrets`); `headersAs` dice cómo se lee: `bearer` (el secreto es un token que se envía como `Authorization: Bearer`) o `list` (el secreto es `nombre=valor,nombre2=valor2`). Las cabeceras nunca se escriben en claro, ni se imprimen, ni van al log. Protocolos: `http/json` y `http/protobuf` (gRPC no). Otros campos: `enabled`, `metrics`/`logs` (`false` para apagar una señal), `logsIntervalMs`, `temporality` (`delta` por defecto) y `resourceAttributes`.

**Subcomandos.**

- `/otel` (o `/telemetry`): informe de solo lectura. Dice si algo sale para la cuenta de la sesión y lista los receptores con su origen, endpoint, protocolo, esquema, señales, cuentas ligadas, si prompts y detalle de herramientas están permitidos, si llevan credenciales (ocultas), el último envío correcto y el último error de esta sesión; después las variables `OTEL_*` vistas con su origen y los destinos que dicta la organización de la cuenta activa. `--json` devuelve lo mismo como JSON.
- `/telemetry test <id>`: envía un punto de prueba (`fnharness.telemetry.test`, sin identidad) a un receptor propio y dice si lo aceptó (`OK ... (HTTP 200)`) o por qué falló. A un receptor de organización no se le envían puntos de prueba.
- `/telemetry add <id> <endpoint> --accounts <a,b|*> [--protocol http/json|http/protobuf] [--schema official|enriched] [--headers-ref <gestor:ref>] [--bearer]`: añade o reemplaza un receptor en `telemetry.json` (se valida con el mismo lector que usa el envío, se escribe en 0600 y se guarda una copia fechada del fichero anterior). `--accounts` es obligatorio.

**Reparto y salida.** Cada receptor tiene su propio `MeterProvider`/`LoggerProvider` (se crean al primer uso, así que un receptor nuevo no hace falta reiniciarlo) y su propio recurso. Al salir se envía lo pendiente con un tope de 2 s por receptor, en paralelo: `-p "hola"` termina en menos de 3 s aunque todos los receptores estén caídos. Un receptor caído solo deja una línea `[telemetry] ...` en el log de depuración (`--debug-file`).

La lógica pura está en `src/utils/telemetry/` (`context.ts`, `sinks.ts`, `otelReport.ts`); el envío en `sinkRuntime.ts` (estado vivo) y `sinkProviders.ts` (SDK, carga perezosa); `instrumentation.ts` y `events.ts` son los puntos de entrada; el comando, en `src/commands/otel/`. Diseño: `docs/plans/otel_telemetry.md`.

### 2.16 Varias cuentas Claude en un arnés (`/account` con OAuth de Anthropic)

Una cuenta `kind: "anthropic"` en `accounts.json` es una cuenta Claude con su propio login OAuth. Sin `kind`, una cuenta sigue siendo OpenAI-compatible (los `accounts.json` antiguos valen igual). La cuenta `claude` es la de siempre: su login sigue en la raíz (`.credentials.json`, identidad en `.claude.json`). Cualquier otra guarda lo suyo en `<config>/accounts/<id>/`:

| Fichero | Contenido |
|---|---|
| `credentials.json` (0600) | tokens OAuth de esa cuenta; carpeta en 0700 |
| `oauth-account.json` (0600) | correo, organización, rol |
| `remote-settings.json` (0600) | ajustes gestionados de su organización |
| `policy-limits.json` (0600) | límites de política de su organización |

| Comando | Efecto |
|---|---|
| `/account` (con `-p`, o `/account list`) | panel «Cuentas»: por cuenta, cabecera `── id · tipo ● sesión ──`, identidad (`correo · organización (org 3f2a…) · plan Team`, o la URL en las OpenAI-compatibles), modelo en uso o recordado y estado (`✓ lista`, `✗ sin login`, `✓ responde`, `✗ no responde`, `✗ desactivada`); para las cuentas Claude, el receptor de telemetría corporativo de sus remote-settings y las políticas que imponen. En la TUI abre el selector, con la identidad en la descripción de cada cuenta Claude |
| `/account import <dir> --as <id>` | copia el login Claude de otro directorio de configuración (p. ej. `~/.fnharness-work`): credenciales, identidad, remote-settings y policy-limits. El origen solo se lee; sigue funcionando con su lanzador. Si su harness renueva el token antes, la cuenta importada adopta el más nuevo al leerlo |
| `/account add claude <id>` | abre el login OAuth normal, pero lo guarda en `accounts/<id>/` y no toca la cuenta `claude`. Repetirlo sobre una cuenta Claude existente renueva su login |
| `/account <id> [modelo]` | cambia la sesión a esa cuenta Claude (su token, su identidad, sus ajustes gestionados); también desde `/model` (`/model claude-work:opus` o el selector, cuya cabecera muestra `── Claude (Anthropic) (claude-work) · correo ──`) |
| `/account approve <id>` | revisa los ajustes gestionados nuevos y peligrosos que trajo una cuenta a mitad de sesión (diálogo con la cuenta y su organización en la cabecera). Aceptar los aplica; rechazar deja la cuenta desactivada en la sesión, que sigue con las demás. Si es la cuenta de la sesión, rechazar cierra fnharness, como al arrancar |
| `/account doctor [--fix]` | comprueba que credenciales y `accounts.json` estén en 0600 y las carpetas de cuenta en 0700; `--fix` los corrige |
| `/logout <id> [--yes]` | cierra una cuenta Claude añadida (no `claude` ni la de la sesión) |

La primera vez que se usa `/account` en un directorio con `.credentials.json` en la raíz y sin cuentas Claude registradas, se registra `claude` como `kind: anthropic` y se **copia** su login a `accounts/claude/` (la raíz no se toca; la copia se mantiene al día cuando este build guarda tokens o ajustes).

Enrutado: `claude-work:sonnet` (agente, frontmatter, `/model`) usa el token de `claude-work` solo para esa petición; dentro de ese ámbito `getOauthAccountInfo()` y `getClaudeAIOAuthTokens()` responden por esa cuenta. Cada cuenta renueva su token con su propio cerrojo (`accounts/<id>.lock`). Una cuenta Claude puede declarar `baseUrl` (un proxy o un servidor de pruebas): sus peticiones y sus ajustes gestionados van ahí.

Ajustes gestionados y políticas (decisión D7): aplican los de todas las cuentas Claude en uso en la sesión (la de la sesión y cada una que haya servido una petición), combinados con lo más restrictivo (`deny` se une, `allow` se interseca, una política está permitida solo si todas la permiten). La telemetría de una cuenta (`OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `otelHeadersHelper`) ya no se escribe en `process.env`: es de esa cuenta (su receptor, ver 2.15) y `/otel` la muestra como tal. La primera petición de una cuenta que no es la de la sesión espera a sus ajustes; si trae ajustes peligrosos nuevos, la cuenta queda desactivada hasta `/account approve <id>`.

Diseño: `docs/plans/otel_telemetry.md` (secciones 2 y 3); código en `src/services/accounts/`.

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
| `--fallback-model <lista>` | Cadena de reserva (coma, máx. 3) si el modelo principal no está disponible; vale en interactivo. Entradas: `modelo`, `cuenta` o `cuenta:modelo` (`qwen36,claude:haiku`). Equivale al ajuste `fallbackModel`. |
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
| `--trust-workdir <dir>` | Sesiones sin humano (salas de Matrix en tmux): confía en `<dir>` (debe ser el cwd) sin mostrar el diálogo de confianza y contesta «sí», solo en esa sesión, al aviso de bypass, a los `.mcp.json` pendientes y a los includes externos de `CLAUDE.md`. Solo flag, nunca variable de entorno. Ver `docs/trust_workdir.md`. |
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
| `--perfil <nombre>` | | Perfil de contexto (`/perfil`); se acepta en cualquier posición y se reenvía al CLI. El lanzador relanza el CLI cuando `/perfil` pide un reinicio (salida 75 y `restart/<pid>.args`). |
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

Salida real de `fnharness --list`: `ollama`, `llamacpp`, `lmstudio`, `openai`, `openrouter`, `groq`, `deepseek`, `gemini`, `mistral`, `together`, `venice`, `custom`.

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
| `venice` | `https://api.venice.ai/api/v1` | `VENICE_API_KEY` | No | `deepseek-v4-1-flash-1017-uncensored` | `max_tokens` |
| `custom` | (vacía; obliga a `CLAUDE_MULTIMODEL_BASE_URL`) | | Sí | `default` | `max_tokens` |

### 4.2 Claves y gestores de secretos (`/secrets`)

Una cuenta puede guardar su clave fuera de `accounts.json` con `apiKeyRef: "<gestor>:<ref>"`
(`src/services/secrets/secrets.ts`). Gestores:

| Gestor | Referencia | Escribe | Notas |
|---|---|---|---|
| `pass` | `pass:apis/venice` | sí | `pass show/insert/rm`; la referencia no puede empezar por `-` ni contener `..` |
| `env` | `env:VENICE_API_KEY` | no | variable de entorno |
| `file` | `file:venice` | sí | `<config dir>/secrets.json`, en claro, modo 0600 |
| `keyring` | `keyring:venice` | sí | `secret-tool` (libsecret); `service=fnharness account=<ref>` |
| `cmd` | `cmd:venice` | no | comando declarado en `secrets.json` → `"commands": {"venice": {"get": "op read op://v/venice/credential"}}` |

Precedencia al arrancar: clave en claro de `accounts.json` (`/account key`, comportamiento anterior) >
variable exportada del proveedor (`VENICE_API_KEY`) > `apiKeyRef`. Si la referencia no se puede leer, el
arranque aborta con el motivo. Cada referencia se lee una vez por proceso. Los mensajes de `/secrets`
nunca incluyen la clave.

| Comando | Efecto |
|---|---|
| `/secrets` | gestor interactivo: elige cuenta y luego guardar, usar existente, mover, probar o desvincular |
| `/secrets list` | cuentas que necesitan clave, de dónde sale cada una y si se lee (sin descifrar) |
| `/secrets backends` | gestores instalados y formato de cada referencia |
| `/secrets set <cuenta> <gestor> [ref]` | pide la clave oculta (nunca por argumento) y la guarda |
| `/secrets use <cuenta> <gestor:ref>` | apunta a un secreto existente, comprobando que se lee |
| `/secrets move <cuenta> <gestor> [ref]` | copia al nuevo gestor y borra la copia anterior si el gestor lo permite |
| `/secrets test <cuenta>` | lee la clave y la prueba contra `GET {baseUrl}/models` (muestra longitud y HTTP, no la clave) |
| `/secrets rm <cuenta> [--purge]` | desvincula; `--purge` borra también el valor del gestor |

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
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` si no estaba definida y `FNHARNESS_PROFILE_NO_TELEMETRY=1` (la analítica no esencial del proveedor se queda apagada; no es `DISABLE_TELEMETRY`, que es solo de la persona y apaga los receptores propios de `/telemetry`).

Otros puntos de integración: `src/services/api/client.ts` enruta las peticiones por el adaptador OpenAI-compatible, `validateModel.ts` omite la validación de modelos y `logoV2Utils.ts` muestra el preset y la URL en la cabecera.

## 6. Lo que no se pudo verificar

- Qué slash commands aparecen en una sesión interactiva real: es una TUI y no se abrió (se evitó cualquier llamada a un modelo). La columna "Backend no-Anthropic" se deduce de `availability`, `isEnabled` y `isHidden` en el código, no de una ejecución con un backend.
- Los gates remotos (`tengu_*`, GrowthBook, Statsig) y las políticas organizativas no pueden evaluarse sin cuenta Anthropic.
- Los subcomandos bajo flag o `USER_TYPE=ant` (sección 3.1) y los slash commands marcados "No encontrado" (sección 2.9): su fuente no está en este snapshot.

## Subagentes en otra cuenta (`cuenta:modelo`)

En la herramienta `Agent` el parámetro `model` es **obligatorio** y siempre lleva cuenta y modelo:
`cuenta:modelo` de una cuenta lista (`claude:haiku`, `claude:opus`, `qwen36:qwen36-35b-heretic-q4km`,
`openrouter:deepseek/deepseek-chat`). Un alias suelto (`sonnet`), un id sin cuenta (`gpt-4.1`), una cuenta
sin modelo (`qwen36:`) o una cuenta que no puede servir se rechazan con un mensaje que explica el formato
y dice el `cuenta:modelo` de la sesión (`validateAgentModelParam`). Así el modelo que lanza un agente
decide siempre en qué cuenta corre, y puede repartir trabajo a modelos de otras cuentas y seguir
gestionándolos con `SendMessage` y `TaskStop`. Para quedarse en la cuenta y el modelo de la sesión se
pasa el valor que la descripción de la herramienta indica (también en los forks, para reutilizar la
caché). `/fork` y `/subtask` sin `--model` rellenan el de la sesión. El subagente corre en esa cuenta y
la sesión sigue en la suya. La descripción de la herramienta lista las cuentas conectadas y unos pocos
modelos de cada una. Como el parámetro va siempre, gana al frontmatter `model:` de
`.claude/agents/*.md` y a `CLAUDE_CODE_SUBAGENT_MODEL`. En el panel de subagentes la fila muestra
`[cuenta]` cuando no es la de la sesión.

Anidamiento de un nivel: un subagente lanzado por la sesión principal conserva la herramienta `Agent`
(también en segundo plano), así un modelo de una cuenta puede delegar a su vez en modelos de otras. Los
agentes que él lance ya no la tienen, y corren siempre en primer plano: quien los lanza espera su
resultado y los gestiona él mismo, sin que su aviso de fin llegue a la sesión principal. Por eso a un
subagente se le rechazan `run_in_background: true` y `name`, y no se pasan solos a segundo plano.
Diseño y límites: `docs/plans/account_routing.md`.

