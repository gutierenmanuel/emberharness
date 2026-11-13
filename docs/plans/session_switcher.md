# Selector de sesiones con ← en fnharness (`session_switcher.md`)

**Resumen ejecutivo.** La flecha ← con el prompt vacío ya abre una vista en fnharness, pero solo lista las sesiones en segundo plano (`BgSessionsDialog`). El plan la sustituye por un selector único que junta cinco fuentes: los registros `sessions/<pid>.json` de fnharness y de Claude Code, `bg/*/meta.json`, el estado del puente de Matrix junto con su socket tmux `matrixterm`, y kitty. No hace falta ningún protocolo nuevo en el socket para descubrir sesiones. Saltar depende del origen de cada sesión: si es una ventana kitty, se enfoca; si corre en tmux (todas las de Element), se adjunta en esta misma terminal como ya hace `terminalPanel.ts`; si está terminada, se reanuda aquí relanzando el CLI. Reanudar aquí una sesión que sigue viva se hace siempre con `--fork-session`, para que dos procesos no escriban el mismo transcript. Calculo unos 90 min de agente en 4 fases, sin dependencias nuevas.

---

## 0. Supuestos y lo verificado

- **El atajo ya existe.** `left: 'chat:agentsView'` está en `src/keybindings/defaultBindings.ts:83`. Su manejador (`PromptInput.tsx:1646-1655`) solo actúa con el prompt vacío, sin sugerencias abiertas, sin el pie seleccionado, sin búsqueda de historial, en modo `prompt` y con `historyIndex == 0`. En cualquier otro caso devuelve `false` y el cursor se mueve con normalidad. Este plan cambia lo que abre, no la tecla. El id de la acción se conserva para no romper los `keybindings.json` de usuario.
- **Las sesiones de Element corren hoy con `claude`, no con fnharness.** Lo comprobé en la máquina: `tmux -L matrixterm` tiene `pc-a-c-1113-1558` con `pane_current_command=claude`, `config_dir=~/.claude`, y su registro está en `~/.claude/sessions/<pid>.json` con socket en `/run/user/1000/cc-socks/`. El plan cubre los dos arneses.
- **Claude Code 2.1.323 escribe el mismo tipo de registro.** Lleva `status`, `name`, `messagingSocketPath` y `peerProtocol:1`. Lo leemos, pero no le hablamos por su socket: su protocolo no es el nuestro.
- **Hay varias instancias de kitty, una por ventana del sistema.** Cada una tiene su propio socket (`listen_on unix:/tmp/kitty-{kitty_pid}`, `allow_remote_control yes`). `kitty @ --to unix:/tmp/kitty-<pid> ls` responde. Hay un aviso: el `KITTY_LISTEN_ON` heredado puede apuntar a un socket que ya no existe (`/tmp/kitty-123775` en esta sesión).
- **Supuesto:** "activas" significa con proceso vivo, o con sesión tmux viva en el caso de Element. Las 129 conversaciones `suspended` de `conversations-pc-a.json` no salen por defecto (ver la tabla de decisiones).

## 1. Lo que ya existe

| Pieza | Fichero | Qué muestra | De dónde saca el estado | ¿Sirve entre sesiones? |
|---|---|---|---|---|
| Registro por proceso | `src/utils/concurrentSessions.ts` (`registerSession`, `updatePidFile` privado, `updateSessionActivity`) | `pid, sessionId, cwd, startedAt, kind, entrypoint, messagingSocketPath, status, waitingFor, updatedAt, name` | Lo escribe cada sesión de nivel superior. `status` lo empuja el efecto de `REPL.tsx:1169` (`busy`/`idle`/`waiting`) porque `BG_SESSIONS` está en el build por defecto. `/clear` y `/resume` reescriben `sessionId` | **Sí, es la base.** Le faltan origen, cuenta, modelo y título |
| Lector del registro | `src/utils/udsClient.ts` (`listAllLiveSessions`, `listPeers`, `resolvePeerSocket`, `sendToUdsSocket`, `formatPeers`) | Sesiones vivas con socket accesible | `isProcessRunning(pid)` + `existsSync(socket)` | Sí, se reutiliza tal cual |
| Buzón UDS | `src/utils/udsMessaging.ts` | — | Protocolo de una petición por conexión. Solo existe `{"type":"message"}`, que se encola como `<cross-session-message>` meta | Sirve para "enviar mensaje". **No** sirve para escribir como si fuera el usuario |
| Herramienta `ListPeers` y `/peers` | `src/tools/ListPeersTool/ListPeersTool.ts`, `src/commands/peers/peers.ts` | Lista en texto con estado, `up`, cwd y dirección | `listPeers()` | Sí. `/peers` es el modelo de comando con `supportsNonInteractive` que sirve para el e2e |
| Sesiones en segundo plano | `src/cli/bg.ts` (`listBgSessions`, `statusOf`, `readBgTail`, `stopBgSession`, `attachHandler`), `bgCore.ts` | `running/done/failed/stopped/lost`, cuenta, prompt, cola del log | `<config>/bg/<id>/meta.json` + pid + fichero `exit` | Sí, pasa a ser una fuente más. `attach` ya decide reanudar si terminó o seguir el log si sigue viva |
| Vista ← actual | `src/components/tasks/BgSessionsDialog.tsx` | Solo las sesiones bg; Enter muestra el log, `x` la para | `listBgSessions()` cada 1,5 s | La sustituye `SessionSwitcher`, que conserva esas acciones en el grupo bg |
| Panel de agentes y pastilla | `src/components/CoordinatorAgentStatus.tsx`, `agentPanelRow.ts`, `src/tasks/pillLabel.ts`, `BackgroundTaskStatus.tsx`, `LocalAgentTaskState` | Subagentes, shells y monitores de **esta** sesión | AppState local | No. Se reutiliza el layout de fila (`agentPanelRow.ts`: texto truncado y tiempo a la derecha) |
| `/tasks` | `BackgroundTasksDialog.tsx` | Tareas de esta sesión | AppState | No |
| Compañeros de equipo (swarm) | `src/utils/swarm/*` (`isIdle`), `TeamsDialog` | Compañeros en proceso o en paneles tmux | AppState; no se registran (`registerSession` sale si `getAgentId()`) | No, quedan fuera de alcance |
| Estado de pestaña | `src/ink/hooks/use-tab-status.ts` | `idle/busy/waiting` (OSC 21337, apagado) | El mismo `sessionStatus` del REPL | Es la misma semántica de estados que hay que mostrar |
| Metadatos del transcript | `src/utils/sessionStoragePortable.ts` (`readSessionLite`, `resolveSessionFilePath`, `extractFirstPromptFromHead`), `src/utils/listSessionsImpl.ts` (`parseSessionInfoFromLite`, `listSessionsImpl`) | `summary`, `customTitle`, `firstPrompt`, `lastModified` | Lee solo 64 KB de cabeza y 64 KB de cola | Sí, da título y última actividad sin protocolo |
| `/resume` entre proyectos | `src/utils/crossProjectResume.ts` | Pide hacer `cd` al directorio | — | Por eso hace falta `--chdir` en el lanzador |
| Reinicio del lanzador | `src/utils/perfilRestart.ts` (`requestRestart`, `buildRestartArgs`), `bin/fnharness` (sale con 75 y lee `restart/<pid>.args`) | — | — | Sí, es la vía de la semántica (c) |
| Ceder la terminal a tmux | `src/utils/terminalPanel.ts` (`enterAlternateScreen` → `tmux -L … attach` → `exitAlternateScreen`) | — | — | Sí, es la vía de la semántica (b) para tmux |
| Canal de eventos de Matrix | `src/utils/matrixEvents*.ts`, `docs/matrix_events.md` | `ready`, `turn_start/end`, `session_start{account,model}` | Fichero `FNHARNESS_EVENTS` | Opcional: estado de las salas fnharness sin depender del registro |
| Estado del puente | `~/.local/state/matrix_terminals/<agente>/<sesion>.json` (`session_id, workdir, config_dir, socket, session, started_at`) y `conversations-<agente>.json` (`room_id, session, title, status, last_activity, claude_session_id`) | Título y sala | Lo escribe `apps/agents_and_robots` | Sí, aporta los metadatos de Element |
| Entorno de un proceso de sala | `/proc/<pid>/environ`: `CLAUDE_TERM_SESSION`, `MATRIX_TERMINAL_STATE_FILE` | — | Lo exporta `launch_claude_terminal_tmux.sh` | Sí, marca el origen `element` sin heurísticas |
| `--fork-session` | `src/main.tsx` (opción, ~1005; uso 2923/3193) | — | — | Sí, evita los dos escritores |

## 2. La tecla (pregunta 1)

- **Por defecto.** Se mantiene la guarda actual: ← abre el selector solo con el prompt vacío. No se propone "cursor en la columna 0 con texto": mantener ← pulsada para ir al inicio de un texto largo abriría el selector sin querer. Con el prompt vacío, ← no tiene otro uso.
- **Choques revisados** (`defaultBindings.ts`):
  - `Footer` `left: footer:previous`, cuando el panel de agentes tiene foco: ya lo cubre la guarda `footerItemSelected`.
  - `Tabs`, `Attachments`, `DiffDialog` y `ModelPicker` usan ← en sus propios contextos modales. `isModalOverlayActive` ya la desactiva ahí.
  - La navegación de historial (`up`/`down`) está cubierta por `historyIndex > 0`.
  - Modo vim: hay que comprobar en el e2e que, en NORMAL, `h` sigue moviendo y ← con el prompt vacío abre el selector.
  - Dentro del selector, ← cierra o vuelve atrás, como ya hace `BgSessionsDialog`, y → abre el detalle.
- **Alternativas** (no sustituyen a ←, se suman):
  - Acorde `ctrl+x ctrl+w` (de *windows*). Está libre: los acordes en uso son `ctrl+x ctrl+e/k/n`. Abre el selector con texto en el prompt, sin tocarlo.
  - Comando `/sesiones` (fichero nuevo), con `list` y `--json` en modo no interactivo para pruebas y scripts.

## 3. Descubrimiento (pregunta 2)

Módulo nuevo `src/utils/sessionDirectory/`. Es puro en el centro y tiene los efectos en los bordes.

**Fuentes (`sources.ts`, impuro, cada una tolera fallos y tiene un tiempo máximo de 300 ms):**

1. **fnharness:** `listAllLiveSessions()`. Ya existe.
2. **Claude Code:** `~/.claude/sessions/*.json` (y `~/.claude-work/...` si existe), con el mismo lector parametrizado por directorio. El lector se pone en un fichero nuevo para no tocar `udsClient`.
3. **bg:** `listBgSessions()` + `statusOf()`.
4. **Element:** `tmux -L <socket> list-panes -a -F '#{session_name}\t#{pane_pid}'` para cada `socket` distinto que aparezca en los ficheros de estado (hoy solo `matrixterm`). Se cruza con `<state_dir>/<agente>/<session>.json` y con `conversations-<agente>.json` (título, `room_id`, `last_activity`). El directorio de estado sale de `MATRIX_TERMINALS_STATE_DIR` o de `~/.local/state/matrix_terminals` (solo lectura de entorno; `process.env` no se escribe).
5. **kitty:** para cada `/tmp/kitty-*` vivo, `kitty @ --to unix:… ls`, que devuelve ventanas con `id` y el `pid` de su shell.

**Origen de cada sesión con proceso** (`origin.ts`, puro sobre un mapa de entorno):

- `CLAUDE_TERM_SESSION` → `element`.
- `TMUX` con `TERM` de tipo screen o tmux → `tmux`.
- `KITTY_WINDOW_ID` → `kitty`.
- `entrypoint`/`kind` = `sdk-*`/`bg` → `headless`.
- Fuente del entorno: lo que la propia sesión escribe en su registro (ver más abajo). Para sesiones antiguas o de Claude Code se usa `/proc/<pid>/environ`, que es del mismo usuario y solo Linux.
- La ventana kitty se confirma subiendo por los padres del proceso (`/proc/<pid>/stat`) hasta dar con el `pid` de una ventana de `kitty @ ls`. Esto protege contra el `KITTY_LISTEN_ON` caducado.

**Registro enriquecido (sin protocolo de socket).** Un fichero nuevo `src/utils/sessionRecord.ts` y un hook `useSessionRecordSync` añaden al `<pid>.json`:

- `origin`: `{ kittyWindowId, kittyListenOn, tmuxSocket, tmuxSession, matrixStateFile, launcherPid }`.
- `account` y `model`, que se reescriben cuando cambian (`/account`, `/model`).

El único cambio en código de upstream es exportar `updatePidFile` como `patchSessionRecord` (una línea) y una llamada al hook en `REPL.tsx` (una línea). El título no se guarda en el registro: el selector lo lee del transcript con `readSessionLite` + `parseSessionInfoFromLite`, en este orden: `customTitle`, luego `summary`/`ai-title`, luego `firstPrompt`. Para Element manda el `title` de `conversations-*.json`.

**Protocolo de socket.** No hace falta `describe`: el registro ya es el "describe", y el estado (`status`, `updatedAt`) ya se empuja. Solo se añadiría `{"type":"describe"}` (respuesta de una línea con lo que hay en memoria) si el e2e mostrara que el estado del fichero llega tarde. Queda como decisión abierta.

**Fusión (`merge.ts`, puro y testeado).**

- Clave principal: `sessionId`.
  - El `session_id` del estado de Element es igual al `sessionId` del registro, sea de claude o de fnharness.
  - El `sessionId` de bg es igual al `sessionId` del registro con `kind: bg`.
- Clave secundaria: `pid`. La terciaria es `tmux:<socket>/<session>`.
- La sesión actual se marca `self` y va arriba.

Fila resultante:

```
{ key, harness: fnharness|claude, origin: kitty|tmux|element|headless|bg,
  status: busy|waiting|idle|done|failed|lost, title, cwd, account?, model?,
  lastActivity, pid?, sessionId?, socket?, kitty?, tmux?, room?, actions[] }
```

- Orden de grupos: `waiting`, `busy`, `idle`, terminadas.
- Dentro de cada grupo, por `lastActivity` descendente.
- La última actividad sale del máximo entre `updatedAt`, el `mtime` del transcript y `last_activity` de Matrix.

## 4. Saltar (pregunta 3)

| Semántica | Pros | Contras / riesgo | Cuándo es la acción por defecto |
|---|---|---|---|
| **(a) Enfocar la ventana kitty** (`kitty @ --to <sock> focus-window --match id:<wid>`) | Cero riesgo para el transcript. La otra sesión sigue intacta. Barato | Solo vale si la sesión vive en kitty. Con varias ventanas kitty, el gestor de ventanas puede bloquear el robo de foco; se detecta con `ls` → `is_focused` y, si falla, se avisa | fnharness o claude en kitty |
| **(b) Attach**, variante tmux: ceder la TTY con el patrón de `terminalPanel.ts` y `env -u TMUX tmux -L <sock> attach -f ignore-size -t <session>`, y volver con `prefix d` | Lectura y escritura reales sobre la misma TUI, sin tocar el proceso ajeno. Funciona igual con claude y con fnharness | Teclear a la vez que el puente (`send-keys`, menos con fnharness, que usa el FIFO). Sin `ignore-size`, el tamaño de esta terminal reduce la sala (afecta a `!screen`). Hay que usar `spawn` asíncrono, no `spawnSync`, para que el buzón UDS propio no se congele. La sesión propia queda en pausa visual | Element y cualquier sesión dentro de tmux |
| **(b') Attach por socket** a una fnharness en kitty: espiar la cola del transcript y escribirle | Funcionaría sin tmux | Hace falta un tipo `{"type":"prompt"}` nuevo (hoy solo hay `message` meta) y una vista que pinte el transcript ajeno. Es caro y es renderizar otra REPL | Ninguna en el MVP: fase 4 opcional. Mientras tanto, "Enviar mensaje" en el detalle (`sendToUdsSocket`, ya existe) |
| **(c) Reanudar aquí** (`requestRestart(['--resume', sid, '--chdir', cwd, '--account', a, '--model', m])` → salida 75 → el lanzador hace `cd` y relanza) | Una sola terminal como punto de entrada de verdad. Vale para bg terminadas y conversaciones cerradas | **Dos escritores del mismo `.jsonl`** si la sesión sigue viva → regla dura: si `sessionId` está en el directorio vivo, solo se ofrece `--fork-session` ("Bifurcar aquí"). La conversación de esta terminal deja de estar viva (sigue en el grupo Recientes, si se activa). Necesita lanzador (`launcherCanRestart`); con `./cli` directo se muestra el comando manual (`manualRestartCommand`) | bg terminada, sesión fnharness muerta o reciente |

**Element:**

- (a) no es viable: no hay ventana kitty, el tmux no tiene cliente.
- **(b) tmux es viable y es la acción por defecto.**
- (c) solo como **bifurcación** (`--fork-session`), que desvincula de la sala. Con arnés `claude` (el caso de hoy) tampoco: el transcript está en `~/.claude/projects` y la regla del plan Matrix (sección 6) es que una conversación no cruza de arnés. Queda como acción desactivada con explicación.
- Las salas suspendidas se reanudan desde Matrix, no desde aquí.

## 5. Interfaz en Ink (pregunta 4)

Componente nuevo `src/components/sessions/SessionSwitcher.tsx`, en la línea de `UnifiedModelPicker`:

- `Dialog`, con `isCancelActive={false}`.
- `FilterInput` propio, registrado antes del `Select`.
- Cabeceras de grupo como opciones desactivadas.
- Filas con el layout de `agentPanelRow.ts`.
- Refresco cada 1,5 s, como `BgSessionsDialog`.

La función pura de filas y filtro va en `sessionDirectory/rows.ts`, con tests.

```
  Sesiones
  9 vivas · 2 esperan respuesta · 1 sala de Element en tmux · Enter salta · → acciones
  Filtro: (escribe para buscar por título, cwd, cuenta o agente)
    ── Esperando ──
  ❯ ◐ kitty   Migrar sync a registry_api        fn_registry      claude:opus   2m
    ── Trabajando ──
    ● element pc-a · Descarga de Slack a BigQuery worktrees/pc-a claude        12s
    ● kitty   Plan session switcher             fnharness        qwen36        40s
    ── En espera ──
    ○ esta    (esta sesión)                     fnharness        claude:sonnet  —
    ○ kitty   Ecualizador PCM16                 fn_registry      claude:sonnet 18m
    ○ tmux    voz-fnclaude                      worktrees/voz…   claude         3h
    ── Segundo plano ──
    ✓ bg 3a1f09c2  resume el repo (done)        fnharness        ollama         1h
  ◐ esperando · ● trabajando · ○ en espera · ✓ terminada · ←/Esc cerrar
```

La primera columna es el origen: `kitty`, `element`, `tmux`, `bg`, `head`, `esta`.

Detalle (→ sobre una fila, ← vuelve):

```
  pc-a · Descarga de Slack a BigQuery
  element · sala !fA6j… · claude · pid 3211889 · tmux matrixterm/pc-a-c-1113-1558
  ── últimas líneas ──
  …(cola del transcript, 12 líneas, como readBgTail)…
  ❯ Adjuntar aquí (tmux, prefix d para volver)
    Bifurcar aquí (--fork-session; no afecta a la sala)
    Enviar mensaje…                      (solo fnharness con socket)
    Parar                                (solo bg, = x de antes)
```

El filtro funciona como en `/model`: todas las palabras deben aparecer en `título cwd cuenta:modelo origen agente`.

## 6. Fases (pregunta 5)

Todo va en un worktree del artefacto (`ensure_artifact_worktree.py '/home/user/fn_registry/apps/fnharness' $CLAUDE_CODE_SESSION_ID --slug session-switcher`), con commits atómicos e integración `merge --no-ff`.

### Fase 1. Directorio de sesiones y registro enriquecido (25 min, sonnet; 1a y 1b en paralelo)

- **1a** (sonnet). `sessionDirectory/{types,origin,merge,rows}.ts` puros, con `*.test.ts` sobre fixtures en `src/utils/sessionDirectory/fixtures/`: registro de fnharness, registro de claude, `meta.json` de bg, estado y conversations de Matrix, salida de `tmux list-panes` y JSON de `kitty @ ls`.
- **1b** (sonnet). `sources.ts` (impuro, tiempo máximo por fuente), `sessionRecord.ts` + `useSessionRecordSync.ts`, export `patchSessionRecord` en `concurrentSessions.ts` y una línea en `REPL.tsx`. Comando `/sesiones` (`src/commands/sesiones/`, una línea en `src/commands.ts`) con `list` y `--json`.
- **Hecho cuando:**
  - `bun test src/utils/sessionDirectory` pasa con estos casos: fusión por `sessionId` de Element con claude, bg con su registro, ventana kitty encontrada por un pid ancestro, socket kitty caducado ignorado y `self` marcado.
  - El e2e nuevo `tests/e2e/sessionSwitcher.e2e.test.ts`, caso 1, pasa. Monta dos sesiones headless sin cerrar (patrón de `peers.e2e.test.ts`), un `MATRIX_TERMINALS_STATE_DIR` falso con una sesión en un tmux propio (`tmux -L fnh-e2e-<rand> new -d`), un `kitty` falso en el `PATH` y `HOME` aislado. `-p "/sesiones list --json"` devuelve las tres con `origin` correcto y sin duplicados.
- **Riesgo:** `kitty @` lento o colgado. Se detecta porque el tiempo de `/sesiones list` supera 1 s en el e2e. Mitigación: tiempo máximo de 300 ms por socket y caché de 2 s.

### Fase 2. Selector en la TUI (25 min, sonnet; depende de 1a)

- `SessionSwitcher.tsx` y `SessionDetail.tsx`.
- En `PromptInput.tsx`: cambiar `<BgSessionsDialog>` por `<SessionSwitcher>` (una línea) y añadir el manejador `chat:sessionSwitcher` para el acorde `ctrl+x ctrl+w` (`schema.ts` + `defaultBindings.ts`, dos líneas).
- El grupo bg conserva "ver log" y "parar". `BgSessionsDialog.tsx` queda en el árbol sin uso, o se borra en la fase 4.
- **Hecho cuando** el caso 2 del e2e pasa en un pseudo-terminal (`startTui`, 140 columnas):
  - ← con el prompt vacío muestra `Sesiones` y las filas de la fase 1.
  - Escribir `eni` deja solo la fila de Element.
  - Esc borra el filtro y Esc otra vez cierra.
  - Con `hola` en el prompt, ← no abre nada y el cursor se mueve (se teclea `X` y queda `holXa`).
  - `ctrl+x ctrl+w` lo abre con texto en el prompt.
  - El grupo bg muestra una sesión de `--bg`.
- **Riesgo:** `j`/`k` del `Select` se comen el filtro. Mitigación: `FilterInput` antes del `Select`, como en `/model`.

### Fase 3. Saltar (35 min; 3a, 3b y 3c en paralelo, sonnet)

- **3a. Enfocar kitty** (`jump/kittyFocus.ts`). Hecho cuando un `kitty` falso en el `PATH` recibe `@ --to unix:… focus-window --match id:<wid>` al pulsar Enter en una fila `kitty`. Además, prueba manual real con dos ventanas kitty.
- **3b. Adjuntar tmux** (`jump/tmuxAttach.ts`, patrón de `terminalPanel.ts` con `spawn` asíncrono y `-f ignore-size`). Hecho cuando, en el pseudo-terminal, Enter sobre la fila de Element muestra la pantalla de la sesión tmux falsa (corre `printf MARCA; cat`), `C-b d` devuelve al prompt de fnharness y la sesión tmux sigue viva.
- **3c. Reanudar o bifurcar aquí** (`jump/resumeHere.ts` + `bin/fnharness` aprende `--chdir <dir>` en el bucle de reinicio con `cd`). Hecho cuando, en una variante de `launcherRestart.e2e.test.ts`, una sesión terminada nacida en `cwd2`, elegida desde una sesión en `cwd1`, relanza el CLI con `--resume <sid>`, y el `<pid>.json` nuevo tiene `cwd = cwd2` y el mismo `sessionId`. Sobre una sesión viva, la acción ofrecida es "Bifurcar" y el `sessionId` nuevo es distinto: el `.jsonl` original no crece.
- **Riesgo de dos escritores.** Se detecta en el e2e de 3c: el tamaño del transcript de la sesión viva no cambia tras bifurcar. La regla vive en la función pura `canResumeInPlace(sid, directorio)`, con test.
- **Riesgo de robo de foco** en el gestor de ventanas. Se detecta porque `kitty @ ls` → `is_focused` sale `false` tras enfocar. En ese caso se muestra un aviso con `kitty @ … focus-window` para lanzarlo a mano.

### Fase 4. Documentación y limpieza (10 min, haiku)

`docs/COMMANDS.md` (`/sesiones`, ←, `ctrl+x ctrl+w`), `FEATURES.md`, `CHANGELOG.md`, `app.md` (sección de piezas) y el estado de este plan. Se borra `BgSessionsDialog.tsx` si ya no tiene usos (`grep`).

- **Hecho cuando:** `grep -rn BgSessionsDialog src` está vacío o justificado y `bun run test:unit` está en verde.

### Fase 5 (opcional, posterior). Attach por socket a fnharness en kitty

Tipo `{"type":"prompt","text"}` en `udsMessaging.ts`: entra como prompt de usuario y no como meta. Detalle con la cola del transcript en vivo y una línea de entrada. Solo si el uso real pide escribir en otra sesión sin cambiar de ventana. **Hecho cuando** el e2e envía `prompt` a la sesión A, el backend falso de A recibe ese texto como mensaje de usuario y el transcript de A lo registra.

Esperas externas (no suman minutos): prueba manual con varias ventanas kitty reales y con una sala de Element viva (las hace la persona).

## 7. Ficheros críticos

| Fichero | Por qué importa |
|---|---|
| `/home/user/fn_registry/apps/fnharness/src/components/PromptInput/PromptInput.tsx` (1646-1655, 2151-2153) | Guarda de ← y punto donde se monta la vista. Cambio de una línea más el manejador del acorde |
| `/home/user/fn_registry/apps/fnharness/src/keybindings/defaultBindings.ts` (83) y `schema.ts` (91) | Acción `chat:agentsView` existente y el acorde nuevo |
| `/home/user/fn_registry/apps/fnharness/src/utils/concurrentSessions.ts` | Registro `<pid>.json`. Solo se exporta `updatePidFile` |
| `/home/user/fn_registry/apps/fnharness/src/utils/udsClient.ts` | `listAllLiveSessions`, `sendToUdsSocket`, que se reutilizan |
| `/home/user/fn_registry/apps/fnharness/src/cli/bg.ts` | Fuente bg y semántica de `attach` que hay que respetar |
| `/home/user/fn_registry/apps/fnharness/src/components/tasks/BgSessionsDialog.tsx` | Vista que se sustituye; sus acciones pasan al grupo bg |
| `/home/user/fn_registry/apps/fnharness/src/utils/terminalPanel.ts` | Patrón para ceder la TTY a tmux |
| `/home/user/fn_registry/apps/fnharness/src/utils/perfilRestart.ts` y `/home/user/fn_registry/apps/fnharness/bin/fnharness` | Reinicio con 75. El lanzador gana `--chdir` |
| `/home/user/fn_registry/apps/fnharness/src/utils/sessionStoragePortable.ts`, `/home/user/fn_registry/apps/fnharness/src/utils/listSessionsImpl.ts` | Título y última actividad del transcript |
| `/home/user/fn_registry/apps/fnharness/src/commands/model/UnifiedModelPicker.tsx` | Plantilla de selector con filtro |
| `/home/user/fn_registry/apps/fnharness/src/screens/REPL.tsx` (1169) | Efecto de estado; una línea para `useSessionRecordSync` |
| `/home/user/fn_registry/bash/functions/infra/launch_claude_terminal_tmux.sh` | Contrato de los ficheros de estado de Matrix y del socket `matrixterm` (solo lectura) |
| `/home/user/fn_registry/apps/fnharness/tests/e2e/tui.ts`, `/home/user/fn_registry/apps/fnharness/tests/e2e/harness.ts`, `/home/user/fn_registry/apps/fnharness/tests/e2e/peers.e2e.test.ts` | Infraestructura e2e que se reutiliza |

Ficheros nuevos: `src/utils/sessionDirectory/*`, `src/utils/sessionRecord.ts`, `src/hooks/useSessionRecordSync.ts`, `src/components/sessions/*`, `src/commands/sesiones/*`, `tests/e2e/sessionSwitcher.e2e.test.ts`.

## 8. Riesgos y alternativas descartadas

- **Protocolo `describe` por socket para descubrir:** descartado en el MVP. El registro `<pid>.json` ya lleva el estado vivo, y el socket de Claude Code no habla nuestro protocolo.
- **Reutilizar el `--resume` del sitio para sesiones vivas:** descartado; corrompe el transcript. Solo con `--fork-session`.
- **Abrir una ventana kitty nueva con `tmux attach` para Element:** se descarta como acción por defecto porque rompe "una sola terminal". Puede quedar como acción secundaria "Abrir en ventana nueva" si se pide (`launch_claude_agent_kitty.sh` sirve de referencia).
- **Reanudar en fnharness conversaciones de `claude`** (`--resume <ruta.jsonl>`): descartado por la regla del plan Matrix (sección 6).
- **Teclear a la vez que el puente** durante el attach: se detecta con mensajes mezclados en la sala. Mitigación: aviso en el detalle y la decisión abierta de adjuntar en solo lectura (`-r`).
- **pid reutilizado:** se detecta porque `/proc/<pid>/cmdline` no contiene `cli`/`claude`. Se descarta la fila.
- **Coste de refresco con más de 30 sesiones:** se detecta con el tiempo de render del e2e. Mitigación: lectura de transcript cacheada por `mtime`.

## 9. Verificación final

```bash
cd /home/user/fn_registry/apps/fnharness/.claude/worktrees/session-switcher
PATH=$HOME/.local/bun-npm/node_modules/.bin:$PATH bun run test:unit
PATH=$HOME/.local/bun-npm/node_modules/.bin:$PATH bun test tests/e2e/sessionSwitcher.e2e.test.ts tests/e2e/bgSessions.e2e.test.ts tests/e2e/launcherRestart.e2e.test.ts tests/e2e/peers.e2e.test.ts
PATH=$HOME/.local/bun-npm/node_modules/.bin:$PATH bun run test:e2e
./cli -p "/sesiones list --json" | jq length      # en la máquina real: >= nº de sockets en /tmp/fnharness-socks
```

Prueba manual: desde una kitty, ← abre el selector; Enter sobre otra ventana la enfoca; Enter sobre `pc-a-c-…` adjunta y `C-b d` vuelve.

## 10. Decisiones abiertas

| # | Decisión | Opciones | Propuesta por defecto |
|---|---|---|---|
| 1 | Cuándo abre ← | Prompt vacío / también con el cursor en la columna 0 | Prompt vacío (ya implementado) + `ctrl+x ctrl+w` |
| 2 | Conversaciones de Element suspendidas | Ocultas / grupo plegado / visibles | Ocultas; `/sesiones --todas` las lista en texto |
| 3 | Grupo "Recientes" (transcripts cerrados de `~/.fnharness/projects`) | Sí, las 10 últimas / no | Sí, las 10 últimas (permite volver tras una reanudación) |
| 4 | Attach a tmux de Element | Lectura y escritura / solo lectura (`-r`) | Lectura y escritura con `-f ignore-size` y aviso |
| 5 | Sesión viva elegida con "reanudar aquí" | Bifurcar (`--fork-session`) / rechazar | Bifurcar, con la etiqueta explícita "Bifurcar aquí" |
| 6 | `describe` por socket | Ahora / solo si el estado llega tarde | Solo si el e2e lo justifica |
| 7 | Fase 5 (attach por socket a kitty) | Hacer / aplazar | Aplazar |
| 8 | Nombre del comando | `/sesiones` / ampliar `/peers` | `/sesiones` (`/peers` sigue siendo mensajería) |

---

**Pasos con tamaño y modelo:**

| Paso | Tamaño | Modelo | Paralelismo |
|---|---|---|---|
| F1a | 15 min | sonnet | En paralelo con F1b |
| F1b | 20 min | sonnet | En paralelo con F1a |
| F2 | 25 min | sonnet | Tras F1a |
| F3a, F3b, F3c | 15 + 15 + 20 min | sonnet | Las tres en paralelo, tras F2 |
| F4 | 10 min | haiku | Al final |

Ningún paso necesita opus. Con el paralelismo, el reloj total queda en unos 90 min. La calibración de `feature` muestra que se tiende a sobreestimar (ratio 0,2), pero son 4 fases con e2e en pseudo-terminal. Las pruebas manuales con kitty y Element real no se suman.

[estimado: 90 min · tipo: feature · slug: session-switcher]

---

## Estado de la implementación (13/11/2026)

Rama `quick/session-switcher`. Se tomaron las decisiones de la sección 10 con su opción por defecto: ← solo con el prompt vacío más el acorde `ctrl+x ctrl+w` (acción `chat:sessionSwitcher`); salas de Element suspendidas ocultas (`/sesiones --todas` las lista); grupo Recientes con las 10 últimas; attach tmux en lectura y escritura con `-f ignore-size`; una sesión viva se bifurca con `--fork-session`; sin `describe` por socket; fase 5 aplazada; comando `/sesiones`.

| Fase | Estado | Dónde |
|---|---|---|
| 1a. Módulos puros | hecha | `src/utils/sessionDirectory/{types,origin,actions,merge,rows,rowLayout,transcriptTail}.ts` con sus tests y fixtures |
| 1b. Fuentes, registro, `/sesiones` | hecha | `sources.ts`, `registryReader.ts`, `procReader.ts`, `terminals.ts`, `src/utils/sessionRecord.ts`, `src/hooks/useSessionRecordSync.ts`, `src/commands/sesiones/` |
| 2. Selector en la TUI | hecha | `src/components/sessions/{SessionSwitcher,SessionDetail,runAction}.tsx`; `PromptInput.tsx` monta `SessionSwitcher` |
| 3a. Enfocar kitty | hecha | `jump/kittyFocus.ts` |
| 3b. Adjuntar tmux | hecha | `jump/tmuxAttach.ts` (con `tmux has-session` previo, antes de ceder la pantalla) |
| 3c. Reanudar o bifurcar aquí | hecha | `jump/resumeHere.ts` y `--chdir` en `bin/fnharness` |
| 4. Documentación y limpieza | hecha | `docs/COMMANDS.md` 2.12c, `FEATURES.md`, `CHANGELOG.md`, `app.md`; `BgSessionsDialog.tsx` borrado |
| 5. Attach por socket | aplazada | sin cambios |

Desviaciones respecto al plan:

- `registerSession` escribe también `harness`, `origin`, `account` y `model` (no solo el hook del REPL), para que las sesiones headless lleven origen. Los parches al registro van en cola.
- El orden de prioridad del origen es element, bg, headless, kitty confirmado por ancestros, tmux. Las sesiones de fnharness de la máquina real viven casi todas en tmux (socket `default`), así que salen como `tmux`.
- En el detalle, "Ver log" no es una acción: la cola del log o del transcript siempre se muestra. En la lista, `x` ya no para una bg (se escribe en el filtro); parar una bg es una acción del detalle.
- Reanudar y bifurcar piden confirmación (Enter dos veces) porque cierran la conversación de esta terminal. La cuenta `default` de una bg no se reenvía como `--account`.
- Las filas "Recientes" omiten las sesiones cuyo título empieza por `/` (pasadas de un comando suelto con `-p`).
- Compilar con el `bun` por defecto (1.4.4). Un `./cli` compilado con el `bun` 1.3.11 de `~/.local/bun-npm` arranca y responde a `-p`, pero la TUI interactiva no pinta nada.
