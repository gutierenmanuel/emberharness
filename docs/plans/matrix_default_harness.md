# FnHarness como arnés por defecto de las salas de Matrix

Plan ejecutable. Fecha: 24/10/2026. Estado: borrador para aprobar, nada implementado.

Objetivo: que cualquier sala de Matrix (DM de un agente, sala de grupo, conversaciones creadas con
`!nueva`, pool precalentado) pueda correr sobre `fnharness` en lugar de `claude`, eligiendo cuenta y
modelo por sala, sin perder fidelidad en el puente y sin romper a los agentes que siguen en `claude`
durante la migración.

## 1. Resultado de la fase 0 (inventario de solo lectura)

### 1.1 Cómo arranca hoy una sesión de sala

- `shell/terminal/bridge.go` (`startSession`) ejecuta `bash launch_claude_terminal_tmux.sh <perfil>
  --socket --session [--workdir] [--agent] [--resume <uuid>] [--command]` y lee la última línea JSON de
  stdout (`session_id`, `created`, ...).
- `bash/functions/infra/launch_claude_terminal_tmux.sh` elige binario y directorio de configuración con
  un `case` por perfil (`fnclaude`, `claude-work`, `fnzcode`, `pc-a`, `asistente-voz`,
  `lista-compra`). Los perfiles con `claude` ponen `env -u CLAUDE_CONFIG_DIR` o
  `CLAUDE_CONFIG_DIR=~/.claude-work`; `fnzcode` usa `~/.local/bin/claude-glm`.
- La línea de comandos que se ejecuta dentro de tmux es:
  `<binario> --dangerously-skip-permissions (--session-id UUID | --resume UUID)
  [--append-system-prompt-file agents/<s>/system_prompt.md] [--mcp-config agents/<s>/mcp.json]
  [--plugin-dir agents/<s>] [--settings <state>/ask-one-question.json]`.
- `--settings` inyecta dos hooks propios: `PreToolUse AskUserQuestion` (`ask_one_question_hook.sh`) y
  `SessionStart` (`matrix_terminal_session_sync_hook.sh`, apunta el `session_id` nuevo tras `/clear` o
  `/resume` en `$MATRIX_TERMINAL_STATE_FILE`).
- Variables que el lanzador exporta dentro de tmux: `CLAUDE_TERM_SESSION`, `CLAUDE_TERM_OUTBOX`,
  `MATRIX_TERMINAL_STATE_FILE`.

### 1.2 Qué lee el puente, y de dónde

| Fuente | Qué obtiene | Dependencia del binario |
|---|---|---|
| Transcript `<config>/projects/*/<sid>.jsonl` (`bridge.go` `transcriptPath`) | Turnos, herramientas, resultados, progreso, tareas en segundo plano (`<task-notification>`), subagentes, errores de hooks, interrupciones | Formato JSONL de Claude Code. fnharness lo conserva y lo escribe en `$CLAUDE_CONFIG_DIR/projects` |
| `capture-pane` (`bridge.go` `screen`) | Diálogo de `AskUserQuestion` abierto (`"Enter to select"`, `"Type something"`), diálogo de permisos (`"do you want to"` + `"1. yes"`), caja de entrada (línea que empieza por `❯` bajo un borde `──`), comando `!screen` | Texto exacto de la TUI |
| Teclas por `tmux send-keys` / `paste-buffer` | Entrada del dueño, respuestas a `AskUserQuestion` (`askkeys.go`) | Disposición de la TUI (orden de opciones, tecla de «Other») |
| Estado y outbox (`CLAUDE_TERM_OUTBOX`, state file) | Mensajes de grupo, session id vigente | Solo el lanzador y los hooks; independiente del binario |

Conclusión: más del 90 % de la fidelidad sale del transcript, que ya es compatible. El scraping de
pantalla se limita a tres puntos: diálogo de `AskUserQuestion`, caja de entrada y permisos. Los
permisos no aparecen con `--dangerously-skip-permissions`, así que quedan dos.

### 1.3 Estado de fnharness frente a ese contrato

| Requisito | Estado | Evidencia |
|---|---|---|
| `--session-id`, `--resume` | Presentes | `src/main.tsx` (validaciones en torno a la línea 1304) |
| `--append-system-prompt-file`, `--mcp-config`, `--plugin-dir`, `--agent` | Presentes | `src/main.tsx` líneas 1003-1009, 1392, 1489 |
| `--settings` con hooks | Presente (heredado) | Por verificar en una prueba |
| `--dangerously-skip-permissions` | Presente | `src/main.tsx` línea 624 y siguientes |
| `-p --input-format stream-json --output-format stream-json --replay-user-messages` | Código presente (`src/cli/print.ts`, `structuredIO.ts`) | **Sin probar** de extremo a extremo con un backend falso |
| Transcript en `$CLAUDE_CONFIG_DIR/projects` | Sí | `bin/fnharness` fija `CLAUDE_CONFIG_DIR=~/.fnharness` |
| Credenciales | `~/.fnharness/.credentials.json` ya es un symlink a `~/.claude/.credentials.json` | Riesgo de login bajo; falta probar la renovación del token con dos binarios |
| Hooks del dueño (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `PostToolUse`, `PreToolUse Agent`) | **Ausentes**: `~/.fnharness/settings.json` solo tiene `model`, `statusLine` y `skipDangerousModePermissionPrompt` | Hay que sincronizarlos |
| MCP del usuario (`~/.claude.json`) | `~/.fnharness/.claude.json` es independiente | Hay que sincronizarlos |
| Cuentas | `accounts.json` solo tiene `active: llamacpp`; la cuenta `claude` es nativa | OK |

### 1.4 Riesgos reordenados tras la fase 0

1. Paridad de entorno (hooks, MCP, skills). Es el riesgo más probable y el más barato de resolver.
2. Los dos puntos de scraping (`AskUserQuestion` y caja de entrada). Acotados, no el problema amplio que
   se temía.
3. Renovación de tokens OAuth compartidos entre `claude` y `fnharness`.
4. Modelos locales llamando mal a las herramientas. Se mitiga con el perfil de contexto Simple y con
   `fallbackModel`.
5. Desfase de versión con Claude Code 2.1.309 (`docs/plans/claude_code_gap.md`).

## 2. Diseño

### 2.1 Selector de arnés

Un campo `harness: claude | fnharness` en `terminal:` de cada `config.yaml` de agente, con valor global
por defecto en la configuración del launcher. El puente lo pasa al lanzador con `--harness`. El lanzador
mantiene sus perfiles por compatibilidad, pero el `case` deja de decidir el binario: decide la cuenta
(`config_dir`, `env_prefix`) y, si `harness=fnharness`, sustituye el binario por `fnharness` y la cuenta
por `--account`.

Regla: `claude` sigue siendo el valor por defecto hasta que la fase 6 lo cambie. Nada cambia para un
agente sin el campo.

### 2.2 Canal de eventos (sustituye al scraping)

Variable `FNHARNESS_EVENTS=<ruta>.jsonl` (apagada por defecto). Con ella, fnharness añade una línea JSON
por evento, con `v` (versión del contrato, empieza en 1), `ts`, `session_id` y `type`:

- `ready`: el prompt acepta entrada.
- `turn_start`, `turn_end`.
- `ask_user`: id de la llamada y opciones (sustituye a `"Enter to select"`).
- `input_echo`: texto actual de la caja de entrada (sustituye a `inputbox.go`).
- `permission_prompt`: por completitud, aunque en bypass no se emita.

Entrada alternativa opcional: `FNHARNESS_INPUT=<fifo>` para inyectar texto y respuestas sin
`paste-buffer`; el evento `ready` evita la carrera de «¿puedo escribir ya?».

El puente lee ese fichero con el mismo patrón que el outbox. Si el fichero no existe (arnés `claude`),
usa el scraping actual. Ambos caminos coexisten.

### 2.3 Modo headless (alternativa por sala, no sustituto)

Si la prueba 3.1 confirma el stream-json bidireccional, una sala puede correr como un proceso sin tmux:
mensajes por stdin, eventos por stdout. Es lo más robusto, pero pierde la terminal visible desde el PC
(`!screen`, panel de subagentes). Se deja como opción posterior (fase 8), no como camino principal.

### 2.4 Paridad de entorno

Script idempotente `apps/fnharness/scripts/sync_env.sh` (o función del registry) que deja
`~/.fnharness` alineado con el repo, sin copiar secretos:

- `settings.json`: fusiona los `hooks` de `~/.claude/settings.json`, conservando `statusLine` y `model`
  propios de fnharness.
- `.claude.json`: sincroniza los `mcpServers` del usuario (sin tokens en claro; si el MCP los lleva, se
  referencian por entorno o por `pass`).
- `hooks/`, `commands/`, `skills`, `CLAUDE.md`: symlinks a `fn_registry/user_claude/` como ya hace
  `~/.claude`.
- Verificación: `sync_env.sh --check` imprime las diferencias sin escribir.

## 3. Fases

Cada fase termina con tests en verde y un commit propio. Rama del repo principal: `agents/pc-a` o
`quick/matrix-harness`. fnharness es un repo anidado (`apps/fnharness/.git`); sus cambios van allí.

### Fase 1. Pruebas de contrato en fnharness (S)

Tareas:
1. Test e2e nuevo `tests/e2e/streamJson.e2e.test.ts`: `-p --input-format stream-json --output-format
   stream-json --replay-user-messages` con el backend OpenAI falso; dos turnos por stdin; comprueba que
   hay eventos `result` por turno y que `session_id` es estable.
2. Test e2e `tests/e2e/launchFlags.e2e.test.ts`: arranca con `--session-id`, `--append-system-prompt-file`,
   `--mcp-config`, `--plugin-dir` y `--settings` con un hook `SessionStart`; comprueba que el hook se
   ejecuta y que el transcript aparece en `$CLAUDE_CONFIG_DIR/projects/*/<sid>.jsonl`.
3. Test de `--resume <uuid>` sobre el transcript generado.

Aceptación: los tres tests pasan sin contactar con ningún proveedor real. Si el 1 falla, la fase 8
(headless) se descarta y no bloquea el resto.

### Fase 2. Canal de eventos en fnharness (M)

Ficheros: `src/utils/matrixEvents.ts` (emisor puro y tipado), puntos de enganche en
`src/screens/REPL.tsx` (ready, turn_start/end, input_echo) y en la herramienta `AskUserQuestion`
(`ask_user`). Documento del contrato: `docs/matrix_events.md` con el esquema y la versión.

Aceptación:
- Sin `FNHARNESS_EVENTS` no se escribe nada y el comportamiento es idéntico (test de regresión).
- Con la variable, el e2e de TUI en pseudo-terminal (`tests/e2e/tui.ts`) comprueba la secuencia
  `ready → turn_start → ask_user → turn_end → ready`.
- Test unitario del esquema (`v`, campos obligatorios).

### Fase 3. Paridad de entorno (S)

`scripts/sync_env.sh` con `--check` y modo escritura. Test: sobre un `HOME` temporal, la ejecución es
idempotente y no toca `statusLine` ni `model`.

Aceptación: `sync_env.sh --check` limpio; arrancar `fnharness` y listar hooks y MCP muestra los mismos
nombres que en `claude`.

### Fase 4. Selector de arnés en el lanzador y el puente (M)

Ficheros:
- `bash/functions/infra/launch_claude_terminal_tmux.sh`: parámetro `--harness`, función
  `_lctt_binary_for` que devuelve el binario y sus flags de cuenta, y exportación de `FNHARNESS_EVENTS`
  cuando corresponda. Test en el `.sh` de pruebas existente: con `--harness fnharness` el comando
  construido contiene `fnharness --account ...` y no contiene `claude-glm`.
- `apps/agents_and_robots/pkg/terminal` y `shell/terminal/bridge.go`: lector `events.go` (puro) que
  traduce eventos a las señales que hoy salen del scraping, con fallback a `capture-pane`. Tests
  unitarios en `events_test.go` con ficheros de eventos de ejemplo en `testdata/`.
- `config.yaml` de agente: campo `terminal.harness` (default `claude`), documentado en la plantilla.
- Validación en `internal/config`: valor desconocido es error de carga.

Aceptación: `go test ./...` del módulo en verde; un agente sin `harness` no cambia su línea de comandos
(test de «golden» del comando).

### Fase 5. Prueba real con un agente de bajo riesgo (M)

Agente piloto: `lista-compra`, en su sala de pareja, con `harness: fnharness` y cuenta `claude`.
Lista de comprobación manual y automatizable (`dev/matrix_tests`):

1. Mensaje del dueño → respuesta → progreso con herramientas.
2. `AskUserQuestion` con botones y respuesta por tecla.
3. `!nueva`, pool precalentado y `--resume` tras dormir la sesión.
4. Tarea en segundo plano y subagente (`<task-notification>`).
5. Nota de voz transcrita.
6. Mensaje a otro agente por `agent_group_send.sh` y respuesta con `✅`.
7. `/clear` y `/resume` actualizan el state file por el hook `SessionStart`.
8. `!screen` devuelve la pantalla legible.

Aceptación: los ocho puntos pasan. Cualquier fallo se corrige en fnharness (preferente) o en el lector
del puente, con test que lo reproduzca.

### Fase 6. Migración gradual (S por agente)

Orden: `lista-compra` → `asistente-voz` → `fnzcode` (la cuenta GLM pasa a ser una cuenta de fnharness y
`claude-glm` se retira) → `fnclaude` → `claude-work` (cuenta de empresa: no migrar sin permiso
explícito del dueño, revisar política de datos) → `pc-a` al final. Cada paso es un cambio de una línea
en `config.yaml` más un reload del agente por la API (`POST /api/v1/bots/<id>/reload`), reversible
volviendo a `harness: claude`.

### Fase 7. Cuenta por sala (M)

Comando `!cuenta [id]` en el puente que cambia la cuenta de la sala (sesión nueva con `--account`) y
guarda la elección en el estado de la conversación. `account_from: dm` pasa a mapearse sobre
`--account`. Coste del modelo visible en la cabecera de la sala.

### Fase 8. Corte del default y headless opcional (S + M)

- Cambiar el default global a `fnharness` cuando las fases 5 y 6 hayan funcionado una semana sin
  incidencias. `claude` queda como `harness: claude` explícito.
- Si la fase 1 lo permitió, modo `headless: true` por sala para agentes sin necesidad de terminal visible
  (p. ej. avisos y bots de tareas).

## 4. Paralelización con subagentes

Las fases 1, 2 y 3 son independientes entre sí (repos y ficheros distintos) y pueden ir en tres
subagentes en paralelo con worktrees separados. La fase 4 depende del contrato de la fase 2 (esquema
fijado en `docs/matrix_events.md`), por lo que el esquema se escribe primero y el lector del puente
puede desarrollarse a la vez que el emisor. Las fases 5 a 8 son secuenciales y requieren al dueño en el
bucle (pruebas reales y política de cuentas).

## 5. Verificación global

- `bun test src scripts` y `bun run test:e2e` en `apps/fnharness`.
- `go test ./...` en `apps/agents_and_robots`.
- Suite `dev/matrix_tests` (Playwright) contra la sala piloto.
- `sync_env.sh --check` limpio antes de cada migración.
- Comprobar que `fnharness --accounts` sigue listando las cuentas y que `claude` no ha perdido su
  `~/.claude`.

## 6. Rollback

- Por agente: `terminal.harness: claude` y reload. No hay migración de datos.
- Global: devolver el default a `claude`.
- Transcripts: viven en `~/.fnharness/projects` y `~/.claude/projects` por separado; un `--resume` de una
  conversación nacida en un arnés no se puede continuar en el otro. Al cambiar de arnés una sala, la
  sesión se abre nueva (el puente ya lo hace al cambiar de cuenta).

## 7. Riesgos abiertos y supuestos sin verificar

- Resuelto en la fase 1: el stream-json bidireccional funciona. `tests/e2e/streamJson.e2e.test.ts` envía
  dos turnos por stdin (el segundo solo tras recibir el `result` del primero), obtiene un evento `result`
  por turno, un único `session_id` y el eco de `--replay-user-messages`. `launchFlags.e2e.test.ts` y
  `resume.e2e.test.ts` cubren `--session-id`, `--append-system-prompt-file`, `--mcp-config`, `--plugin-dir`,
  `--settings` con hook `SessionStart`, transcript en `$CLAUDE_CONFIG_DIR/projects/*/<uuid>.jsonl` y
  `--resume <uuid>`; todos pasan contra el backend falso. Por tanto la fase 8 (headless) no se descarta.
  Nota: stream-json con `--output-format stream-json` exige `--verbose` junto a `-p`.
- Corregido de paso en el harness e2e: `stripAnsi` convertía los saltos de cursor `ESC[nC` en nada (palabras
  pegadas) y el pty de `script` ignoraba `COLUMNS` (80 columnas, toasts truncados); ahora se fija con `stty`.
  Esos fallos preexistentes rompían 3 tests TUI.
- La renovación de tokens con credenciales compartidas entre dos binarios no se ha probado.
- Algunos hooks del dueño (`model_router.py`, `goal_*`) pueden asumir variables o rutas de `~/.claude`;
  la fase 3 los revisó uno a uno: ninguno falla de forma dura bajo `CLAUDE_CONFIG_DIR=~/.fnharness`
  (`~/.claude` sigue existiendo), pero los `goal_*` comparten `~/.claude/goals` y dos dependen de la
  ubicación del transcript. Tabla completa en [`docs/sync_env.md`](../sync_env.md).
- El panel de subagentes bajo el prompt y la cabecera propia de fnharness cambian la pantalla; si el
  canal de eventos de la fase 2 cubre `ask_user` e `input_echo`, esos cambios dejan de importar para el
  puente.
- La cuenta de empresa (`claude-work`) no se migra sin autorización expresa.

## 8. Decisiones pendientes del dueño

1. Agente piloto de la fase 5 (propuesto: `lista-compra`).
2. Si `fnzcode` pasa a cuenta de fnharness en la fase 6 o se mantiene aparte.
3. Si el cambio de default de la fase 8 se hace en bloque o agente por agente.

## 9. Resultado del piloto (fase 5)

Fecha: 24/10/2026. Alcance: validación de extremo a extremo y aislada de que el puente de Matrix gobierna una
sesión de `fnharness` a través del lanzador. No se tocó ningún agente real, sala real, servicio, `config.yaml`,
`~/.claude`, `~/.claude.json` ni `~/.fnharness`; tampoco se contactó con ningún proveedor LLM (el modelo es
`scripts/mock_openai.ts`).

### 9.1 Cómo se probó

Test Go opt-in `apps/agents_and_robots/shell/terminal/harness_e2e_test.go`, que monta por sí solo: socket tmux
propio, `MATRIX_TERMINALS_STATE_DIR`, `FNHARNESS_HOME` y workdir temporales, el backend falso en un puente libre, una
cuenta `pilot` (`accounts.json` 0600, tipo `custom`, perfil de contexto `tools: full` para que exista
`AskUserQuestion`) y un `CLAUDE_CONFIG_DIR` ajeno en el entorno para comprobar que el lanzador lo sustituye. Usa el
puente real con un sender de pruebas (mensajes, botones, notices, hilos y estado de sala), el lanzador real
(`--harness fnharness --account pilot`) y el `fnharness` real compilado. Se salta salvo con `FNHARNESS_E2E=1` y
`FNHARNESS_BIN`, así que `go test ./...` normal no cambia. Comando para repetirlo:

```bash
cd apps/agents_and_robots
FNHARNESS_APP=~/fn_registry/apps/fnharness \
FN_TERMINAL_LAUNCHER=~/fn_registry/bash/functions/infra/launch_claude_terminal_tmux.sh \
  dev-scripts/run_harness_e2e.sh                       # añade -run '...' para un subtest
```

Tarda unos 30 s. Resultado final de la corrida (con los arreglos de 9.3):

```
--- PASS: TestHarnessE2EFnharness (29.6s)
    a_linea_json_del_lanzador, b_session_start_y_ready, c_mensaje_del_dueno_por_el_FIFO,
    h_screen_legible_con_cabecera, d_ask_user_y_ask_answer, e_clear_session_switch_y_transcript_nuevo,
    f_subagentes_en_segundo_plano, f2_monitor_en_segundo_plano, g_resume_tras_matar
--- PASS: TestHarnessE2EClaudeUnchanged (0.44s)
```

### 9.2 Lista de comprobación (a)–(i)

| | Comprobación | Resultado | Evidencia |
|---|---|---|---|
| a | La línea JSON del lanzador trae `harness`, `events_file`, `input_fifo` y `config_dir` | Pasa | `a_linea_json_del_lanzador`: `harness=fnharness`, `config_dir` = `FNHARNESS_HOME` (aunque el entorno traía otro `CLAUDE_CONFIG_DIR`), eventos y FIFO bajo el estado temporal, el FIFO es un pipe. Antes del arreglo 1 la sesión ni arrancaba. |
| b | El fichero de eventos recibe `session_start` y `ready` | Pasa | `session_start` con el `session_id` del lanzador, `account: pilot`, `resumed: false`, seguido de `ready`. |
| c | El mensaje del dueño entra por el FIFO y la respuesta del modelo llega a la sala | Pasa | Mensaje `ECO: hola mundo` → evento `input_accepted` con id `br-*` (prefijo del puente, así que no fue `paste-buffer`) → la sala recibe `MOCK eco: hola mundo` y el transcript está en `FNHARNESS_HOME/projects`. |
| d | `AskUserQuestion` detectada por `ask_user`, respondida con `ask_answer` y recibida por el modelo | Pasa | Quick-reply con las opciones Mercadona/Dia; evento `ask_user`; al responder `Dia` el log del puente registra `terminal_fifo_ask_answer` (no cayó a teclas), llega `ask_user_done` con `answered: true` y el modelo contesta `MOCK recibio: User has answered your questions: "¿Dónde compro?"="Dia"`. |
| e | `/clear` produce `session_switch` y el puente sigue el transcript nuevo | Pasa (tras el arreglo 2) | `session_switch` con `reason: clear` y `old_session_id` correcto; el fichero de estado apunta al id nuevo; `MOCK eco: tras el clear` sale del transcript nuevo. Antes del arreglo el puente volvía al transcript viejo y reenviaba a la sala turnos ya publicados. |
| f | Tarea en segundo plano y subagente reflejados | Pasa (tras el arreglo 3) | `AGENT_DEMO` (dos `Agent` con `run_in_background`): raíz del hilo publicada como notice, actividad del subagente dentro del hilo, raíz editada a «Hecho», `com.organic.agent_status` con `Agents` > 0 y `task-notification` en el transcript. `MONITOR_DEMO`: `agent_status` con `Monitors` > 0 y el modelo recibe el `<event>` (`MOCK saw the monitor event`). Un `Bash` en segundo plano no se probó por separado: comparte el seguimiento de `bgtasks.go`, que solo lee el transcript. |
| g | `--resume` tras matar la sesión retoma el mismo transcript | Pasa | `!kill` con confirmación, `sb.resume` = id vigente (lo que hace el despertar de una conversación), `!start`: `session_start` con `resumed: true` y el mismo `session_id`, estado sin cambios, un único `.jsonl` con la conversación anterior y la nueva. Nota: un `!start` de la sesión base tras `!kill` sin `resume` abre una sesión nueva, igual que con `claude`; solo las conversaciones piden `--resume`. |
| h | `!screen` devuelve la pantalla legible | Pasa | La captura incluye la cabecera propia (`FnHarness v0.8.0 · base 2.1.87`, mascota, cuenta y ruta), el eco del mensaje, la respuesta y el pie `bypass permissions on`. |
| i | El mismo recorrido con `--harness claude` queda idéntico | Pasa (parte sin Claude real) | `TestHarnessE2EClaudeUnchanged` con un `claude` falso en `PATH`: argumentos exactamente `--dangerously-skip-permissions --session-id <id>`, sin `--account`; `FNHARNESS_EVENTS`, `FNHARNESS_INPUT` y `CLAUDE_CONFIG_DIR` sin definir; la salida del lanzador y el fichero de estado sin campos de fnharness; `pollEvents` declina y el prompt va por tmux. Además `launch_claude_terminal_tmux_test.sh` conserva sus comprobaciones byte a byte de la salida de claude. |

### 9.3 Fallos encontrados y arreglos

1. **El lanzador y `bin/fnharness` no coincidían en el directorio de configuración** (la inconsistencia sospechada).
   El lanzador devolvía `${FNHARNESS_HOME:-~/.fnharness}` como `config_dir`, pero `bin/fnharness` usa
   `CLAUDE_CONFIG_DIR`. Confirmado. Arreglo en el lanzador (1.13.1): con fnharness exporta
   `CLAUDE_CONFIG_DIR=$FNHARNESS_HOME` dentro de tmux. Test en `launch_claude_terminal_tmux_test.sh`: el proceso
   recibe ese valor aunque el entorno traiga otro.
2. **`bin/fnharness` rechazaba `--account` si no iba el primero.** El lanzador lo añade detrás de
   `--dangerously-skip-permissions --session-id ...` y el CLI responde `unknown option '--account'`, de modo que la
   sesión tmux moría al nacer (fallo preexistente de la fase 4, que solo se había probado con un fnharness falso).
   Arreglo en el envoltorio: extrae `--account X` y `--account=X` de cualquier posición. Test e2e
   `tests/e2e/wrapperAccount.e2e.test.ts` (rojo con el envoltorio anterior).
3. **`/clear` no actualizaba `<config>/sessions/<pid>.json`.** `regenerateSessionId` no avisa a los suscriptores de
   `onSessionSwitch`, así que el registro por proceso se quedaba con el id viejo. El puente lo usa como segunda capa
   (`syncLiveSession`) y devolvía el estado al transcript anterior, con lo que reenviaba a la sala turnos ya
   publicados y no mostraba los nuevos. Arreglo en fnharness: nueva señal `onSessionRegenerate` (aparte de
   `onSessionSwitch`, para que el canal de eventos siga distinguiendo `clear` de `resume`) y `concurrentSessions` la
   usa para reescribir el fichero. Test en `tests/e2e/matrixEvents.e2e.test.ts`.
4. **El `agent-<id>.meta.json` del subagente no llevaba `toolUseId`.** `ParseSubagentMeta` del puente exige ese campo
   para colgar el hilo de la raíz publicada; sin él, ningún hilo de subagente se abría. Arreglo en fnharness:
   `runAgent` y la limpieza de worktree de `AgentTool` lo escriben. Test en `accountRouting.e2e.test.ts` (el id
   coincide con el `tool_use` del transcript).
5. Menor, en el puente: `sendAskAnswerFIFO` registra `terminal_fifo_ask_answer` al responder por el FIFO, para poder
   distinguir en el log (y en el piloto) la vía del FIFO de la de teclas.

Sobre el contrato (`docs/matrix_events.md`): además de los eventos y del FIFO, el puente lee dos ficheros que fnharness
debe mantener como Claude Code: `<config>/sessions/<pid>.json` (con el `sessionId` vivo) y
`<proyecto>/<sessionId>/subagents/agent-<id>.meta.json` (con `agentType`, `description` y `toolUseId`).

### 9.4 Voz y mensajes entre agentes: no dependen del binario

- **Nota de voz (punto 5 de la fase 5):** se transcribe antes de llegar al puente (`agents/handler.go`, tras el ACL,
  con `voice.stt`), y su texto sustituye al cuerpo del mensaje; el puente solo recibe texto y lo entrega por el FIFO
  o por tmux. Nada en `shell/terminal` toca audio.
- **`agent_group_send` y `CLAUDE_TERM_OUTBOX` (punto 6):** el lanzador exporta `CLAUDE_TERM_OUTBOX` en cualquier arnés
  (antes del bloque de fnharness), `agent_group_send.sh` solo añade una línea JSON a ese fichero y el puente lo lee
  (`shell/terminal/outbox.go`, `pollOutbox`) en cada vuelta de `runSession`, también con eventos activos. Las
  herramientas de fnharness heredan el entorno del proceso, así que el script ve la variable. No se probó el envío
  real a una sala de grupo porque el piloto es de una sola sala.

### 9.5 No cubierto y avisos para la migración

- No se ejecutó el hook `SessionStart` ni el hook `PreToolUse AskUserQuestion` del `--settings` del lanzador contra
  fnharness: con eventos activos el `session_switch` los sustituye para el id de sesión, y el hook de una pregunta por
  vez (varias preguntas en una llamada) no se probó. El `/resume` interactivo dentro de la TUI tampoco; solo
  `--resume` al lanzar.
- Un `FNHARNESS_HOME` nuevo muestra el aviso interactivo del modo bypass hasta que `settings.json` lleva
  `skipDangerousModePermissionPrompt: true` (el `~/.fnharness` real ya lo tiene). Una sala sobre un home nuevo se
  quedaría esperando ese diálogo.
- Al arrancar, fnharness intenta instalar el marketplace de Anthropic (`✓ Anthropic marketplace installed` en la
  pantalla): es un acceso de red ajeno al proveedor LLM. Conviene desactivarlo para las salas de Matrix.
- Con `terminal.config_dir` fijado en el `config.yaml` de un agente, el puente lo prefiere al `config_dir` que
  devuelve el lanzador: con fnharness hay que dejarlo vacío o igual a `FNHARNESS_HOME`.
- Los tests Go de `shell/terminal` usan por defecto el lanzador de `~/fn_registry`; el piloto necesita el lanzador con
  el arreglo 1 (`FN_TERMINAL_LAUNCHER`) hasta que ese árbol principal se actualice.
- El `./cli` compilado del árbol principal de fnharness (el que usa `~/.local/bin/fnharness`) es anterior a los
  arreglos 3 y 4: hay que ejecutar `bun run build` allí antes de lanzar salas reales. El piloto contra ese binario
  antiguo falla en los subtests `e` y `f`, que es justo lo que corrigen esos arreglos.
