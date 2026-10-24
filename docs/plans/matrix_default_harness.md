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

- El stream-json bidireccional está en el código pero no se ha ejecutado aquí (fase 1 lo decide).
- La renovación de tokens con credenciales compartidas entre dos binarios no se ha probado.
- Algunos hooks del dueño (`model_router.py`, `goal_*`) pueden asumir variables o rutas de `~/.claude`;
  la fase 3 debe revisarlos uno a uno.
- El panel de subagentes bajo el prompt y la cabecera propia de fnharness cambian la pantalla; si el
  canal de eventos de la fase 2 cubre `ask_user` e `input_echo`, esos cambios dejan de importar para el
  puente.
- La cuenta de empresa (`claude-work`) no se migra sin autorización expresa.

## 8. Decisiones pendientes del dueño

1. Agente piloto de la fase 5 (propuesto: `lista-compra`).
2. Si `fnzcode` pasa a cuenta de fnharness en la fase 6 o se mantiene aparte.
3. Si el cambio de default de la fase 8 se hace en bloque o agente por agente.
