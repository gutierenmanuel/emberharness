# Brecha de fnharness frente a Claude Code actual (24/10/2026)

Informe del bloque B de `ROADMAP.md`. Compara fnharness (fork del snapshot reconstruido de Claude
Code 2.1.87) con Claude Code 2.1.309, instalado aquí como `claude`.

## Método y límites

- Versión local: `claude --version` = 2.1.309. Opciones y subcomandos: `claude --help`.
- Changelog completo: `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
  (secciones 2.1.88 a 2.1.309, unas 6800 líneas). Las versiones de «desde cuándo existe» salen de la
  primera línea `Added` que lo menciona; donde no la encontré lo digo.
- Documentación oficial leída en markdown (`https://code.claude.com/docs/en/<página>.md`): `commands`,
  `tools-reference`, `scheduled-tasks`, `goal`, `workflows`, `agent-view`, `permission-modes`,
  `auto-mode-config`, `hooks`, `channels`, `fast-mode`, `output-styles`, `statusline`, `memory`,
  `plugins/mods/overview`. Índice: `https://code.claude.com/docs/llms.txt`.
- Estado en fnharness: leído del código (`src/commands.ts`, `src/tools.ts`, `src/tools/`,
  `src/skills/bundled/`, `src/main.tsx`, `scripts/build.ts`, `FEATURES.md`, `docs/COMMANDS.md`).
  Cuando digo «ausente» es que no hay código ni gancho; los flags de comando/subcomando de
  `main.tsx` los comprobé con grep, así que un flag declarado de forma inusual podría escaparse.
- No se arrancó ningún `claude` interactivo ni `claude -p`, ni se usaron terminales virtuales: la
  documentación y el código bastaban. No se compiló fnharness: «presente tras flag» significa que
  el código existe y `FEATURES.md` dice que compila, no que lo haya probado en ejecución.
- Importante para entender la base: `scripts/build.ts` activa por defecto **solo `VOICE_MODE`**.
  El resto de flags solo entran con `build:dev:full` (lista `fullExperimentalFeatures`), y muchos
  flags están rotos porque falta el módulo que importan.

Leyenda de estado: **ausente** (no hay código), **flag-roto** (hay ganchos pero falta un módulo, no
compila), **flag-ok** (compila, apagado por defecto), **presente**. Esfuerzo: S (horas), M (1-3 días),
L (semana o más). Dependencia: **Anthropic** = necesita backend de Anthropic o login claude.ai y no
funcionaría con proveedores OpenAI-compat; **modelo** = funciona, pero la calidad depende del
modelo local; **ninguna** = puramente local.

## Tabla resumen

Orden = prioridad sugerida para uso diario como agente de terminal con modelos locales y Claude.

| # | Funcionalidad | Estado en fnharness | Esfuerzo | Dependencia | Prioridad |
|---|---|---|---|---|---|
| 1 | `/loop` autopaced + `ScheduleWakeup` (y Cron*) | Cron* + `/loop` fijo: flag-ok `AGENT_TRIGGERS`; `ScheduleWakeup` y modo autopaced: ausente | S (activar) + M (wakeup) | ninguna | Alta |
| 2 | Tool `Monitor` | flag-roto `MONITOR_TOOL` (falta `MonitorTool.js` y `MonitorMcpTask`) | M | ninguna | Alta |
| 3 | `/goal` | **hecho** (rama `quick/goal`, 24/10/2026) | M | modelo (evaluador) | Alta |
| 4 | `fallbackModel` (ajuste) + hooks nuevos | **hecho** (24/10/2026, ramas quick/fallback-hooks y quick/small-pack): cadena de fallback entre cuentas y los 33 eventos de hook, más el tipo `mcp_tool` | S | ninguna | Alta |
| 5 | Sesiones en segundo plano y agent view (`--bg`, `claude agents`, `attach`, `logs`, `stop`, `/background`) | flag-roto `BG_SESSIONS` (falta `src/cli/bg.js`); vista ausente | L | ninguna | Media-alta |
| 6 | `/fork`, `/subtask` (subagente bifurcado) | flag-roto `FORK_SUBAGENT` (falta `commands/fork`); `/subtask` ausente | M | ninguna | Media |
| 7 | Auto mode (clasificador de permisos) | flag-roto `TRANSCRIPT_CLASSIFIER` (falta el prompt `.txt`); `BASH_CLASSIFIER` flag-ok | L | modelo (clasificador) | Media |
| 8 | Workflows dinámicos (`Workflow`, `/workflows`) | flag-roto `WORKFLOW_SCRIPTS` (solo `constants.ts`) | L | modelo | Media-baja |
| 9 | Pack de comodidad: `/recap`, `/cd`, `/autocompact`, `/focus`, `/tui fullscreen`, `/reload-skills`, `/skill-doctor`, `skillOverrides`, `--safe-mode`, `--restricted` | `/recap` ≈ flag-ok `AWAY_SUMMARY`; el resto ausente | S cada uno, M el conjunto | ninguna | Media |
| 10 | Mensajería entre sesiones (`ListAgents`, `SendMessage` entre sesiones) y `PushNotification` | `PushNotification` local **hecha** (quick/small-pack, 25/10/2026); mensajería: flag-roto `UDS_INBOX` (falta `udsMessaging.js`) | M-L | ninguna (en local) | Media-baja |
| 11 | Mods (plugins que modifican la UI/comportamiento) | ausente | L | ninguna | Baja |
| 12 | `claude import` / `/import` (Codex, Gemini, Cursor) | ausente | S-M | ninguna | Baja |
| 13 | Channels (eventos empujados desde MCP) | flag-ok `KAIROS_CHANNELS` parcial | M | Anthropic (login claude.ai) | Baja |
| 14 | `/schedule` y routines en la nube, `RemoteTrigger` | flag-ok `AGENT_TRIGGERS_REMOTE` | — | Anthropic | Descartar |
| 15 | Fast mode, `/advisor`, `/usage` de plan, `/ultrareview`, `/autofix-pr`, teleport, Remote Control, Artifacts, Claude Design, voz | varios presentes pero inertes | — | Anthropic | Descartar |
| 16 | Recarga en caliente de servidores MCP (`/mcp reload`, `reconnect all`, watcher de `.mcp.json`, reinicio de stdio, aviso de tools al modelo) | **hecho** (24/10/2026, rama `quick/mcp-reload`; ver `docs/plans/mcp_reload.md`). Va más allá de Claude Code 2.1.310, que no vigila `.mcp.json` ni relanza stdio en interactivo | M | ninguna | Alta |

Ya presentes y sin brecha relevante (verificadas): `EnterWorktree`/`ExitWorktree` y `--worktree`/`--tmux`,
`/rewind` (`/checkpoint`), `/plugin` con marketplaces, `/statusline` y `statusline.sh`, `/output-style`
(oculto: se maneja desde `/config`), `/context`, `/stats`, `/cost`, `/tasks`, `/btw`, `/branch`,
`/compact`, `/memory` con memdir y `EXTRACT_MEMORIES`, skills y `/skills`, `/agents`, `LSP`,
`ToolSearch`, `TaskCreate/Get/List/Update/Stop`, `NotebookEdit`, `/sandbox`, `/add-dir`, `/effort`,
`/mcp`, `/hooks` con 33 eventos y tipos `command`, `prompt`, `agent`, `http`, `mcp_tool`, skills empaquetadas
`batch`, `simplify`, `loop` (apagada), `debug`, `verify`, `claude-api`, `update-config`.

## Estado de las tandas 1 y 2 (rama quick/loop, 24/10/2026)

Hecho, con tests unitarios (`bun test`) y prueba de extremo a extremo en pseudo-terminal contra un
servidor OpenAI simulado (`scripts/mock_openai.ts`):

- `AGENT_TRIGGERS` y `MONITOR_TOOL` activos en el build por defecto; `AGENT_TRIGGERS_REMOTE` fuera.
- `/loop` de intervalo fijo (cron calculado en `src/utils/loopSchedule.ts`), `CronCreate/List/Delete`
  ya sin diferir (los modelos locales no usan bien `ToolSearch`).
- `ScheduleWakeup` y `/loop` autopaced, con aviso de respaldo a los 20 min y centinela
  `<<autonomous-loop>>`. Verificado: la espera de 60 s dispara de nuevo `/loop` y el modelo se
  reprograma.
- `Monitor` (comando en segundo plano, una notificación por lote de líneas, filtros `include` y
  `exclude`, plazo, `persistent`, `TaskStop`, pastilla `N monitors`).

Pendiente de esas tandas:

- ~~Esc no cancela una espera de `/loop` autopaced~~: hecho en quick/small-pack (ver «Estado del
  paquete pequeño»).
- Los wake-ups no se restauran con `--resume` (Claude Code tampoco restaura los autopaced); las
  tareas cron de sesión tampoco: solo existe el modo `durable: true` en `.claude/scheduled_tasks.json`.
- No se probó el aviso de respaldo de 20 min de extremo a extremo (cubierto por tests de la máquina
  de estados en `loopSchedule.test.ts`).
- `Monitor`: sin fuente WebSocket; no se detiene al parar el subagente que lo creó salvo vía
  `killShellTasksForAgent`; el límite de memoria `CLAUDE_CODE_TOOL_MEMORY_LIMIT` no se aplica.
- Con `fixed` + prompt de mantenimiento, el texto de `loop.md` se copia al crear la tarea cron, así
  que editarlo no afecta a un bucle ya creado (en modo dinámico sí, porque cada vuelta reentra en la skill).
- `PushNotification` ya existe en local (quick/small-pack); `SleepTool` sigue sin existir.

## Estado del panel de subagentes (rama quick/agents-panel, 24/10/2026)

Hecho: los subagentes (primer y segundo plano) se listan bajo el prompt, una fila por agente con
`main` arriba, navegables con ↑/↓, `Enter` abre el transcript, `x` para o limpia, `Esc` deselecciona.
Era código de 2.1.87 compilado fuera; ahora lo activa `AGENT_PANEL_ENABLED`. Comparación, capturas y
diferencias restantes (árbol `├ └` al lanzar, agente `Explore` integrado, `Message @tipo…`) en
`docs/plans/agents_panel.md`.

## Enrutado por cuenta y /model unificado (rama quick/account-routing, 24/10/2026)

Hecho (va más allá de Claude Code, que solo conoce una cuenta): `cuenta:modelo` enruta una petición
a otra cuenta sin mover la sesión. Subagentes en otra cuenta (`Agent` `model`, frontmatter), con
ventana, autocompact, salida máxima y coste calculados con su cuenta y modelo; fila del panel con
`[cuenta]`; `/model` con los modelos de todas las cuentas conectadas, por cuenta y filtrable, y
`/model cuenta:modelo`. Probado de verdad: sesión en `qwen36` con subagente `claude:haiku` por OAuth.
Detalle y límites: `docs/plans/account_routing.md`.

## Estado del punto 4: fallbackModel y hooks nuevos (rama quick/fallback-hooks, 24/10/2026)

Hecho, con tests unitarios y e2e (`tests/e2e/cli.e2e.test.ts`):

- **Cadena de fallback entre cuentas.** Ajuste `fallbackModel` (cadena o lista) y `--fallback-model a,b,c`
  (coma; el flag gana al ajuste), máximo 3 entradas sin duplicados, válidos también en interactivo.
  Formato de cada entrada: `cuenta` (`qwen36`), `cuenta:modelo` (`claude:haiku`, `openrouter:x/y`) o
  `modelo` de la cuenta activa. El prefijo cuenta una cuenta solo si es `claude`, un preset o una
  cuenta guardada, así que ids con dos puntos (`qwen3:8b`) siguen siendo modelos. Código:
  `src/services/api/fallbackChain.ts` (parseo y elección puros con tests; estado mínimo para aplicar
  y restaurar), enganchado en `withRetry.ts` y `query.ts`.
- **Cuándo salta.** Tras 3 intentos fallidos con error de disponibilidad (5xx, 529, o el 503 que el
  adaptador devuelve con «conexión rechazada» a un `llama-server` caído), solo en peticiones de
  primer plano. Auth, facturación, límite de uso (429) y 4xx no saltan. Las entradas no resolubles
  (falta la clave, cuenta desconocida) se saltan. Avisa con un mensaje de sistema de nivel warning.
- **Dura un turno**, como en Claude Code: el siguiente prompt del hilo principal restaura la cuenta
  principal (`restorePrimary`) y la prueba otra vez. No toca `accounts.json`.
- **Hooks nuevos** (formato de `https://code.claude.com/docs/en/hooks.md`): `PostToolBatch` (entrada
  `tool_calls`, `additionalContext`, `decision: block`/`continue:false` paran el bucle), `DirectoryAdded`
  (`directory`, `source`; en segundo plano), `PreModelSwitch` (`from_model`, `to_model`,
  `requested_model`, `source`, más `from_account`/`to_account`; bloquea con exit 2,
  `decision: block` o `permissionDecision: deny`; matcher sobre el nombre canónico de `to_model`) y
  `PostModelSwitch` (mismos campos; stdout o `additionalContext` llegan al modelo con la siguiente
  petición, solo el del último cambio). Se disparan desde `/model <x>`, el selector de `/model`,
  `/account` (y su selector) y `/add-dir`. Código: `utils/hooks.ts`, `commands/model/switchGuard.ts`,
  `commands/account/actions.ts` (`switchAccountWithHooks`), `utils/hooks/pendingHookContext.ts`.

Pendiente de este punto:

- `PreModelSwitch` con `ask`: se trata como rechazo (la doc lo permite solo en `/model` interactivo,
  aquí no hay diálogo de confirmación). El timeout del hook sí bloquea.
- `PreModelSwitch` / `PostModelSwitch` no se disparan aún desde `Alt+P`, `/config`, fast mode,
  `set_model` del SDK ni al restaurar el modelo en `--resume` (`source: sdk`/`resume`/`auto` están
  en el esquema). Tampoco desde el fallback: la doc oficial no los lanza para la sustitución de un turno.
- Los campos de coste de `PreModelSwitch` (`prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`,
  `pricing`) se rellenan con valores neutros y `context_tokens` vale 0 salvo que el llamante lo pase.
- El fallback no se aplica a subagentes como cadena independiente (cambian la cuenta global hasta el
  siguiente turno principal) ni se salta modelos con ventana menor al compactar.
- `DirectoryAdded` con `source: register_repo_root` (SDK) no tiene aún disparador; `--add-dir` de
  arranque no lo dispara (igual que la doc).
- ~~Siguen ausentes `UserPromptExpansion`, `MessageDisplay` y `mcp_tool`~~: hechos en quick/small-pack
  (ver «Estado del paquete pequeño»).
- El aviso del cambio sale solo como mensaje de sistema en el hilo; `/status` no muestra la cadena.

## Estado del paquete pequeño (rama quick/small-pack, 25/10/2026)

Hecho, con tests unitarios y e2e (`tests/e2e/smallPack.e2e.test.ts`, backend falso):

- **Esc cancela la espera de `/loop` autopaced.** Con el prompt vacío, sin turno en marcha y un
  wake-up pendiente, `Esc` lo borra, termina el bucle y avisa «Pending wakeup cancelled». Durante un
  turno `Esc` sigue interrumpiéndolo como siempre. Código: `utils/loopWakeup.ts`
  (`cancelPendingWakeup`), señal en `bootstrap/state.ts`, `hooks/useCancelRequest.ts`.
- **`UserPromptExpansion`.** Se lanza al expandir un `/comando` tecleado de tipo prompt (skill,
  comando propio; `mcp_prompt` para prompts MCP). Entrada `expansion_type`, `command_name`,
  `command_args`, `command_source`, `prompt`; matcher sobre `command_name`. Bloquea con exit 2 o
  `decision: block` (+ `reason`); `additionalContext` o stdout en texto plano llegan al modelo como
  contexto. No se dispara cuando el modelo invoca la skill con la tool `Skill` (como en la doc).
  Código: `executeUserPromptExpansionHooks` en `utils/hooks.ts`, enganchado en `processSlashCommand.tsx`.
- **`MessageDisplay`.** Sustituye el texto mostrado de un mensaje del asistente con
  `hookSpecificOutput.displayContent`; solo pantalla (transcript, modelo y modo verbose conservan el
  original). Sin matcher; si el hook falla, agota el tiempo (10 s) o sale con 2, se ve el original.
  Código: `utils/hooks/messageDisplay.ts`, `components/messages/HookedMarkdown.tsx`.
- **Hook `mcp_tool`.** `{type: "mcp_tool", server, tool, input, timeout}`; los strings de `input`
  admiten `${ruta}` sobre el JSON de entrada del hook (ruta inexistente = cadena vacía). La salida se
  trata como la de un hook `command`: un objeto JSON puede traer decisiones; `isError: true` o un
  servidor no configurado/no conectado es un error no bloqueante. Resuelve el servidor por nombre
  entre los ajustes y `--mcp-config`. Tiempos por defecto de la doc (600 s; 30 s en
  `UserPromptSubmit`/`PreModelSwitch`/`PostModelSwitch`; 10 s en `MessageDisplay`). En
  `SessionStart` y `Setup` se omite (los servidores aún no están conectados). Código:
  `utils/hooks/execMcpToolHook.ts`.
- **`PushNotification` local.** Tool `PushNotification {message, title?}`: notificación de escritorio
  con `notify-send` (hint `suppress-sound`, nunca sonido ni campana); si no existe o falla, aviso en
  la TUI; sin interfaz (`-p`) lo indica en el resultado. Se desactiva con el ajuste
  `pushNotificationEnabled: false` (la tool deja de ofrecerse). Código:
  `tools/PushNotificationTool/`.

Pendiente de este paquete:

- `MessageDisplay` se ejecuta una vez por mensaje terminado (`index` 0, `final` true, `delta` = todo el
  texto), como la doc describe para ejecuciones no interactivas; no por lotes de líneas mientras
  llega el stream. Mientras el hook responde (hasta su timeout) el texto del mensaje no se muestra.
  Solo actúa en la TUI interactiva, no en `-p` ni en el modo SDK. Un `displayContent` vacío oculta el
  texto (la doc no lo define). El `turn_id` es uno por proceso y el `message_id` sale del hash del texto.
- `UserPromptExpansion` no cubre los comandos locales (`/model`, `/hooks`…), solo los de tipo prompt.
- `mcp_tool`: la salida en texto plano no se inyecta como contexto (solo JSON cuenta); las
  herramientas MCP no pasan por el sistema de permisos al ser llamadas desde un hook; no admite
  servidores de plugins con nombre `plugin:<p>:<s>` si no están en la configuración de MCP activa.
- `PushNotification`: sin parte móvil (depende de Remote Control, de Anthropic) y sin ajuste en el
  menú `/config` (solo `settings.json`). Sin pruebas con un escritorio real: el binario se simuló
  por `PATH`.

## Detalle por funcionalidad

### 1. `/loop` (fijo y autopaced), `ScheduleWakeup` y herramientas Cron

- **Qué hace en Claude Code actual.** `/loop [intervalo] [prompt]` es una skill empaquetada que
  repite un prompt mientras la sesión sigue abierta. Con intervalo (`/loop 5m ...`) lo convierte a
  cron y lo programa con `CronCreate`. Sin intervalo (`/loop revisa el CI`) Claude **elige él el
  intervalo** entre 1 min y 1 h tras cada iteración y lo reprograma con la tool `ScheduleWakeup`
  (con `stop: true` termina el bucle). Sin nada ejecuta un prompt de mantenimiento o el `loop.md`
  del proyecto. En una sesión con Monitor, Claude puede usarlo en vez de sondear. Las tareas son de
  sesión, se restauran con `--resume` y caducan a los 7 días; `/usage` tiene un desglose «Loops»
  (2.1.243). Tools relacionadas: `CronCreate`, `CronDelete`, `CronList`.
- **Estado en fnharness.** Existen `src/tools/ScheduleCronTool/{CronCreate,CronDelete,CronList}Tool.ts`,
  `src/skills/bundled/loop.ts` y el planificador (`utils/cronTasks`, `cronScheduler`). Todo cuelga de
  `feature('AGENT_TRIGGERS')`, que **no está en el build por defecto** (sí en `dev-full`). La skill
  usa `isKairosCronEnabled()`, que además consulta el gate remoto `tengu_kairos_cron` con default
  `true`, de modo que sin GrowthBook queda activa. `loop.ts` solo implementa el modo de intervalo
  fijo (default `10m`); **no existe `ScheduleWakeup`** ni el modo autopaced. `SleepTool` es solo un
  `prompt.ts` (parte de `PROACTIVE`/`KAIROS`, flag-roto).
- **Esfuerzo.** Activar `AGENT_TRIGGERS` en `defaultFeatures`: S (compilar, probar `/loop 1m ...`,
  comprobar que el gate de GrowthBook no bloquea sin red). `ScheduleWakeup` + autopaced: M, es una
  tool que escribe una tarea cron de un disparo y devuelve control; hay que adaptar el prompt de
  `loop.ts` a la versión nueva. No depende de Anthropic.
- **Prioridad.** Alta: es lo que más se usa para vigilar CI, despliegues y PRs.
- **Fuentes.** `https://code.claude.com/docs/en/scheduled-tasks.md`, `.../tools-reference.md`
  (filas `ScheduleWakeup`, `CronCreate`), changelog 2.1.243.

### 2. Tool `Monitor`

- **Qué hace.** Ejecuta un comando en segundo plano y devuelve a Claude cada línea de salida como
  evento durante la conversación (tail de logs, sondeo de CI, vigilar un directorio). También abre
  un WebSocket y trata cada mensaje como evento. Cada vigilancia tiene plazo (5 min por defecto,
  máx. 30; 10 en `-p`), usa las mismas reglas de permiso que Bash y se detiene con la tarea o el
  subagente que la creó. Aparece en el changelog en 2.1.98.
- **Estado.** `src/tools.ts` la importa tras `feature('MONITOR_TOOL')` desde
  `tools/MonitorTool/MonitorTool.js`, que **no existe**; tampoco `tasks/MonitorMcpTask/`, aunque
  `tasks/types.ts` ya referencia `MonitorMcpTaskState`, `LocalShellTask.tsx` ramifica por
  `kind === 'monitor'`, y el último commit propio ya hace que la pastilla de tareas cuente los
  monitors. Es decir, hay hueco para encajarla. En `docs/COMMANDS.md` no aparece.
- **Esfuerzo.** M. Se puede construir sobre `LocalShellTask` (proceso en segundo plano con lectura
  línea a línea y notificación al bucle de mensajes, como ya hacen las notificaciones de
  `Bash run_in_background`); WebSocket opcional y se puede dejar fuera de la primera versión.
  Ninguna dependencia de Anthropic.
- **Prioridad.** Alta; combina con el punto 1 (vigilar sin gastar tokens en sondeos).
- **Fuentes.** `.../tools-reference.md#monitor-tool`, changelog 2.1.98.

### 3. `/goal`

- **Qué hace.** `/goal <condición>` mantiene a Claude trabajando turno tras turno hasta que un
  evaluador (el «small fast model» configurado) dice que se cumple o que es imposible. Es un
  envoltorio de un **hook Stop de tipo prompt** con ámbito de sesión; muestra overlay con tiempo,
  turnos y tokens, funciona en interactivo, `-p` y Remote Control (2.1.139). `/goal clear` lo
  quita. Se corta si Claude responde varios turnos sin usar herramientas.
- **Estado.** **Implementado** (24/10/2026, rama `quick/goal`). Comando integrado `/goal`
  (`src/commands/goal/`), lógica pura en `src/utils/goal/goalLogic.ts` y estado + juez en
  `goalState.ts`. En vez de registrar un hook `prompt` literal, se engancha en
  `handleStopHooks` (`src/query/stopHooks.ts`): tras cada turno principal llama al evaluador y,
  si no se cumple, añade su motivo como mensaje meta y el bucle de `query()` continúa; así se
  controlan cuenta del juez, contador de turnos y corte por turnos sin herramientas. Funciona en
  interactivo y en `-p` (los comandos `local-jsx` con `supportsNonInteractive` entran ahora en
  el modo headless). Evaluador por defecto = cuenta activa; `--judge <cuenta>`,
  `FNHARNESS_GOAL_JUDGE` o ajuste `goalJudge`. Pendiente: overlay propio (hoy una línea de
  sistema + notificación del pie por turno), persistencia entre reinicios y Remote Control.
- **Esfuerzo.** M: comando local que registra un hook Stop temporal de sesión, evaluador que llama
  al modelo activo (o a una cuenta barata elegida por ajuste), overlay de estado y reglas de
  parada. Con modelos locales pequeños el veredicto «cumplido» será poco fiable: conviene permitir
  fijar la cuenta del evaluador en otra distinta de la del agente (por ejemplo Claude Haiku).
- **Prioridad.** Alta: convierte tareas largas en «dejar y volver».
- **Fuentes.** `https://code.claude.com/docs/en/goal.md`, changelog 2.1.139.

### 4. Ajuste `fallbackModel` y hooks nuevos

- **fallbackModel (2.1.166).** Hasta tres modelos de reserva en orden cuando el principal está
  saturado o no disponible; `--fallback-model` ahora vale también en interactivo. fnharness solo
  tiene el flag de CLI. Con multi-proveedor es especialmente útil: caer del modelo local a otra
  cuenta cuando `llama-server` no responde. S-M (el reintento ya existe en `withRetry`; hay que
  decidir cómo se expresa un fallback *entre cuentas*, no solo entre modelos). Prioridad alta.
- **Eventos de hook ausentes** (tabla de `https://code.claude.com/docs/en/hooks.md`): `PostToolBatch`,
  `UserPromptExpansion`, `MessageDisplay` (2.1.152, transforma u oculta texto mostrado),
  `DirectoryAdded` (2.1.219), `PreModelSwitch` y `PostModelSwitch` (2.1.251). fnharness tiene
  los otros 27. Cada uno: S, salvo `MessageDisplay` (M, toca el render).
- **Tipo de hook `mcp_tool`**: ausente (hay command, prompt, agent y http). S-M.
- Ninguno depende de Anthropic. Prioridad media-alta (`PreModelSwitch/PostModelSwitch` interesan
  al multi-proveedor).

### 5. Sesiones en segundo plano y agent view

- **Qué hace.** `claude --bg "tarea"` lanza una sesión sin terminal y devuelve un id; `claude agents`
  abre una vista única con todas las sesiones (necesita tu input / trabajando / terminadas),
  `claude attach|logs|stop|rm|respawn <id>`, `/background` desvincula la sesión actual, `/stop`,
  `/resume` las lista marcadas `bg`, `/tasks`. Research preview desde 2.1.139. Cada sesión es una
  conversación completa con su worktree opcional.
- **Estado.** `feature('BG_SESSIONS')` aparece en `main.tsx`, `query.ts`, `REPL.tsx`,
  `concurrentSessions.ts` y `conversationRecovery.ts`, pero `src/cli/bg.js` (despacho rápido de
  `claude --bg`/`ps`/`logs`/`attach`/`kill`) falta, por eso el flag no compila (`FEATURES.md`: «easy
  reconstruction»). El subcomando `agents` de `main.tsx` es el de definiciones de subagentes, no la
  vista de sesiones. No hay `attach`, `logs`, `stop`, `respawn`.
- **Esfuerzo.** L. Reconstruir `bg.js` (demonio mínimo o `nohup` + registro en
  `~/.fnharness/sessions/`), más una vista TUI de agentes. Se puede arrancar con un MVP de
  `--bg`/`logs`/`attach` sin vista (M). Sin dependencia de Anthropic.
- **Prioridad.** Media-alta: sustituye lanzar varios terminales a mano. Ojo: la política de este
  entorno ya reparte paralelismo con subagentes nativos; el valor es sesiones largas independientes.
- **Fuentes.** `.../agent-view.md`, `.../sessions.md`, `claude --help` (comandos `agents`, `attach`, `logs`, `stop`, `rm`, `respawn`).

### 6. `/fork` y `/subtask`

- **Qué hace.** `/fork [prompt]` copia la conversación a una sesión en segundo plano y sigues aquí;
  `/subtask <tarea>` lanza un **subagente bifurcado** que hereda toda la conversación y devuelve su
  resultado a la actual (`https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation`).
- **Estado.** `commands.ts` reserva el hueco tras `FORK_SUBAGENT` pero falta
  `src/commands/fork/index.js`; `/branch` (bifurcar la conversación localmente) sí existe.
  `/subtask`: ausente.
- **Esfuerzo.** M (el soporte de renderizado ya está). `/fork` real depende del punto 5.
- **Prioridad.** Media.

### 7. Auto mode (clasificador de permisos)

- **Qué hace.** Modo de permisos en el que un clasificador separado revisa cada acción antes de
  ejecutarla y bloquea lo irreversible, lo que apunta a infraestructura desconocida o lo inducido
  por contenido hostil; respeta reglas `deny`/`ask`. Desde 2.1.283 es el modo inicial por defecto
  en terminal. Configurable con el bloque `autoMode` (`environment`, reglas), `/auto-mode-setup`
  (2.1.304), `claude auto-mode ...`, hook `PermissionDenied` con `{retry: true}`, y revisa también
  los `SendMessage` entre agentes. Clasificador por defecto: Sonnet 5; hay revisión en servidor.
  Solo acepta ciertos modelos de Anthropic.
- **Estado.** Hay mucho código: `utils/permissions/yoloClassifier.ts` (1495 líneas),
  `autoModeState.ts`, `classifierDecision.ts`, `denialTracking.ts`, subcomando `auto-mode`, hook
  `PermissionDenied`. Pero `TRANSCRIPT_CLASSIFIER` **no está en ningún build** y está roto: falta
  `utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt` (y los `permissions_*.txt`).
  `BASH_CLASSIFIER` compila pero es de la variante interna de Anthropic.
- **Esfuerzo.** L: reescribir los prompts del sistema (no hay fuente; hay que redactarlos), definir
  el contrato de salida y probarlo. `sideQuery` pasa por `getAnthropicClient`, así que con el
  adaptador OpenAI-compat el clasificador *técnicamente* llega al modelo de la cuenta activa, pero
  un clasificador de seguridad con un modelo local pequeño es poco fiable y añade una llamada por
  acción (latencia y tokens). No requiere servicios de Anthropic en sí, pero la calidad exige un
  modelo fuerte.
- **Prioridad.** Media. Alternativa barata y más predecible para modelos locales: `acceptEdits` +
  reglas `allow` + `/sandbox`, y la skill `fewer-permission-prompts` (generar la lista de
  permitidos a partir de las transcripciones) en vez de un clasificador.
- **Fuentes.** `.../permission-modes.md#eliminate-prompts-with-auto-mode`, `.../auto-mode-config.md`,
  changelog 2.1.89, 2.1.283, 2.1.304.

### 8. Workflows dinámicos

- **Qué hace.** Herramienta `Workflow` + `/workflows`: un script JavaScript que Claude escribe (skill
  `workflow-authoring`) y un runtime ejecuta en segundo plano orquestando muchos subagentes, con
  variables en el script, pausa/reanudación y vista de progreso; también se puede reejecutar. Hay
  workflows empaquetados como `/deep-research`. Ajustes «Workflow keyword trigger» y «Dynamic
  workflow size» en `/config` (2.1.157, 2.1.202).
- **Estado.** `WORKFLOW_SCRIPTS`: flag-roto. Solo existe `tools/WorkflowTool/constants.ts`; falta
  `commands/workflows`, el `WorkflowTool` real, `bundled/index.js` y `LocalWorkflowTask`.
- **Esfuerzo.** L: runtime de scripts con API de agentes, estado reanudable, tarea y diálogo de
  progreso. Sin dependencia de Anthropic, pero con modelos locales el valor se limita a unos pocos
  agentes concurrentes (un solo `llama-server` serializa).
- **Prioridad.** Media-baja para este uso. Mejor invertir antes en puntos 1-6; `/batch` (ya
  empaquetado) cubre parte del caso.
- **Fuente.** `.../workflows.md`.

### 9. Pack de comodidad (todos S, sin Anthropic)

| Comando / ajuste | Desde | Qué hace | Estado en fnharness |
|---|---|---|---|
| `/recap` | 2.1.108 | Resumen de una línea al volver a la sesión (y automático tras ausencia) | `/recap` manual HECHO (`commands/recap/`, no necesita el flag). El aviso automático tras ausencia sigue tras `AWAY_SUMMARY` + GrowthBook `tengu_sedge_lantern` (false en 3P): pendiente |
| `/cd <ruta>` | n/d | Mueve la sesión a otro directorio conservando la conversación | HECHO (`commands/cd/`; exige directorio ya confiado; la transcripción sigue en su proyecto original) |
| `/autocompact [auto\|tokens]` y `--autocompact` | n/d | Ventana de autocompactación configurable (100k a 1M) | HECHO (`/autocompact` y `--autocompact`, `services/compact/autoCompactOverride.ts`; umbral en tokens, no ventana; solo sesión) |
| `/focus` | 2.1.269 (tip) | Vista con solo el último prompt, resumen de herramientas y respuesta final | ausente |
| `/tui fullscreen` | 2.1.110 | Renderizador alt-screen sin parpadeo | ausente |
| `/reload-skills` | 2.1.152 | Reescanea skills sin reiniciar | HECHO (`commands/reload-skills/`, avisa al REPL con `skillChangeDetector.notifyChanged()`) |
| `/skill-doctor` | 2.1.261 | Coste en contexto y uso de cada skill | ausente |
| `skillOverrides` (settings) | n/d | Forzar visibilidad de skills desde ajustes | ausente |
| `--safe-mode` | 2.1.169 | Arranca sin CLAUDE.md, skills, hooks, MCP ni plugins (diagnóstico) | HECHO (`isSafeMode()` en `utils/envUtils.ts`, con test e2e) |
| `--restricted` | 2.1.248 | Quita herramientas que ejecutan código y confina archivos | ausente |
| `--system-prompt-snapshot`, `--permission-prompts`, `--exclude-dynamic-system-prompt-sections`, `--prompt-suggestions`, `-n/--name`, `--plugin-url`, `--forward-subagent-text`, `--ax-screen-reader` | varias | Opciones de CLI nuevas | ausentes (hay servicio `PromptSuggestion`, sin flag) |
| `/powerup`, `/team-onboarding` | 2.1.90, 2.1.101 | Lecciones interactivas; guía de onboarding de equipo | ausentes, baja utilidad |
| `claude purge`, `claude doctor` | n/d | Borrar estado de un proyecto | `doctor` presente; `purge` ausente |

Estos son los de mejor relación valor/coste para un solo usuario: `--safe-mode`, `/cd`, `/recap`,
`/autocompact` y `/reload-skills` primero. Fuentes: `.../commands.md`, `claude --help`, changelog.

### 10. Mensajería entre sesiones y notificaciones push

- **Qué hace.** `SendMessage` puede enviar a otras sesiones locales de Claude Code (2.1.224) y
  `ListAgents` / `/list-agents` las descubre; `PushNotification` avisa con notificación de
  escritorio (y al móvil con Remote Control) al terminar algo largo; `SendUserFile` entrega
  archivos al usuario.
- **Estado.** `UDS_INBOX` flag-roto (falta `utils/udsMessaging.js`; el comando `peers` y `ListPeersTool`
  están referenciados), `KAIROS_PUSH_NOTIFICATION` flag-roto (falta la tool), `SendUserFile` bajo
  `KAIROS` (flag-roto, pila grande). `SendMessageTool` existe para equipos de agentes.
- **Esfuerzo.** M-L la mensajería (socket Unix por sesión + registro), S la notificación local
  (`notify-send` desde una tool simple; la parte móvil depende de Remote Control, que es Anthropic).
- **Prioridad.** Media-baja; la notificación local de «tarea terminada» es barata y útil junto al
  punto 5.

### 11. Mods

- **Qué hace.** Desde 2.1.287 un plugin puede ser un «mod»: manejadores JS/TS que corren dentro del
  proceso, dibujan paneles o bandas en la interfaz, reemplazan filas de herramientas, el spinner o
  diálogos, interceptan llamadas a herramientas y añaden comandos sin turno de modelo. La skill
  `plugin-authoring` guía su creación.
- **Estado.** Ausente (el sistema de plugins clásico, `/plugin`, marketplaces y `PluginTrustWarning`,
  sí está).
- **Esfuerzo.** L: es una API de extensión nueva y un contrato público de eventos.
- **Prioridad.** Baja; sin demanda concreta, y choca con la regla KISS del repo.
- **Fuente.** `https://code.claude.com/docs/en/plugins/mods/overview.md`.

### 12. `claude import` / `/import`

- Trae a Claude Code configuración de Codex, Gemini CLI y Cursor (instrucciones, MCP, comandos,
  subagentes, skills), con `--dry-run`. Ausente. S-M. Sin dependencia. Prioridad baja (una sola vez).
  Fuente: `.../commands.md` (`/import`), `claude --help`.

### 13. Channels

- Un servidor MCP empuja mensajes, alertas y webhooks a la sesión abierta (CI, chat). Research
  preview; **exige autenticación Anthropic** (claude.ai o clave de Console) y no está en
  Bedrock/Vertex/Foundry. fnharness tiene `KAIROS_CHANNELS` (flag-ok, parcial: avisos y
  callbacks, sin la pila de asistente). Con cuenta no-Anthropic la puerta de acceso falla; habría
  que quitar el control de autenticación. M. Prioridad baja, y se cubre en parte con `Monitor`.
  Fuente: `.../channels.md`.

### 14 y 15. Descartables por depender de Anthropic

| Funcionalidad | Qué es | Por qué no |
|---|---|---|
| `/schedule`, routines, `RemoteTrigger`, `/autofix-pr` | Tareas programadas en la nube de Anthropic (mín. 1 h) | Backend de claude.ai; el equivalente local es el punto 1 |
| Fast mode (`/fast`) | Opus 2,5x más rápido a mayor coste | Configuración de API exclusiva de Anthropic; en `COMMANDS.md` ya figura «No» |
| `/advisor` | Segundo modelo consultado en momentos clave | Herramienta del lado servidor de la API |
| `/usage` de plan, `/extra-usage`, `/usage-credits`, `/upgrade` | Límites y créditos de suscripción | OAuth claude.ai; `/cost` y `/stats` cubren lo local |
| `/ultrareview`, `ultracode` | Revisión multiagente en la nube; esfuerzo extra | Nube de Anthropic. `/code-review` local se cubre con `/review` y `/simplify` |
| `/teleport`, `--cloud`, `/remote-control`, `/desktop`, `/mobile`, `/web-setup` | Sesiones en la nube, relevo entre dispositivos | Requieren claude.ai |
| `/artifacts`, `/design*`, `/slides` | Páginas publicadas en claude.ai | Servicio de Anthropic (y contradice la regla local-first del usuario) |
| `/voice` | Dictado | Requiere OAuth claude.ai |
| `EndConversation`, `/passes`, `/stickers`, `/radio` | Varios | Sin valor para este uso |

## Plan de ataque sugerido (para el bloque B del roadmap)

1. **Tanda 1 (S, un día).** Añadir `AGENT_TRIGGERS` a `defaultFeatures`; comprobar `/loop` y
   `CronCreate`; `--safe-mode`; `/cd`; `/recap` manual sobre `AWAY_SUMMARY`; hooks nuevos
   (`PostToolBatch`, `DirectoryAdded`, `Pre/PostModelSwitch`); ajuste `fallbackModel`.
2. **Tanda 2 (M).** `ScheduleWakeup` y `/loop` autopaced; `Monitor` sobre `LocalShellTask`;
   `/goal` con evaluador seleccionable por cuenta.
3. **Tanda 3 (M-L).** `BG_SESSIONS`: `--bg`, `logs`, `attach`, `stop` primero, vista de agentes
   después; `/fork`/`/subtask`; notificación local.
4. **Tanda 4 (L, opcional).** Auto mode (decidir antes si compensa frente a `acceptEdits` +
   sandbox), workflows, mensajería entre sesiones.

Riesgos a tener en cuenta: (a) muchos módulos que faltan son lo que Anthropic no publicó, así que
«reconstruir» es escribir código nuevo guiado por la documentación, no recuperarlo; (b) activar
flags en el build por defecto puede cambiar el arranque (probar con `bun run build` y
`fnharness --account <cuenta>`); (c) los prompts de sistema de herramientas nuevas (Monitor,
ScheduleWakeup) deben probarse con los modelos locales, que siguen peor instrucciones largas.
