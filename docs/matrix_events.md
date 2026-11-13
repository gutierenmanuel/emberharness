# Contrato de eventos y entrada para el puente de Matrix (v2)

Estado: implementado en fnharness (fase 2 de `docs/plans/matrix_default_harness.md`): emisor en
`src/utils/matrixEvents.ts` (lógica pura) y `src/utils/matrixEventsRuntime.ts` (efectos), tests en
`src/utils/matrixEvents.test.ts` y `tests/e2e/matrixEvents.e2e.test.ts`.
La v2 es aditiva sobre la v1: añade `session_start.caps`, los eventos `entry` y `mcp_settled`, las reglas de
recorte y la garantía de orden de las `entry` (secciones marcadas «v2»). Un lector v1 que ignore lo que no
conoce sigue funcionando; el lector acepta `v >= 1`.
Quien cambie este documento sube `v` y actualiza a la vez el emisor (fnharness) y el lector (puente
`apps/agents_and_robots`, paquete `pkg/terminal`).

Motivo: el puente de Matrix lee de Claude Code el transcript JSONL (turnos, herramientas, tareas en
segundo plano) y, para lo que el transcript no cuenta, hace scraping de la pantalla con `tmux
capture-pane`: el diálogo de `AskUserQuestion` y la caja de entrada. Este contrato reemplaza ese
scraping por eventos estructurados. El transcript sigue siendo la fuente de verdad de los turnos; en v1 los
eventos solo cubrían lo que el transcript no registra. En v2 el evento `entry` además transporta cada
entrada del transcript principal, de modo que el puente no necesita localizar ni sondear el fichero JSONL
(que cambia de nombre con `/clear` o `/resume`): el fichero de eventos es uno por proceso y no cambia.

Todo es opcional y está apagado por defecto: sin las variables de entorno de abajo, fnharness no escribe
ni lee nada extra y se comporta exactamente igual que antes.

## Canal de salida: `FNHARNESS_EVENTS`

Ruta de un fichero JSONL. fnharness lo abre en modo append (creándolo con permisos 0600 si falta) y
escribe una línea JSON por evento, con un único `write` por línea para que un lector que sigue el
fichero (`tail -f`) nunca vea una línea partida. Si no puede escribir, lo ignora sin interrumpir la
sesión.

Campos comunes a todos los eventos:

| Campo | Tipo | Significado |
|---|---|---|
| `v` | entero | Versión del contrato (hoy `2`; el lector acepta `v >= 1`) |
| `seq` | entero | Contador monótono por proceso, desde 1; permite detectar huecos |
| `ts` | cadena | Instante ISO 8601 en UTC |
| `session_id` | cadena | UUID de la sesión vigente (cambia tras `/clear`, `/resume` o compactación) |
| `type` | cadena | Tipo de evento (tabla siguiente) |

Tipos de evento:

| `type` | Campos propios | Cuándo se emite |
|---|---|---|
| `session_start` | `cwd`, `account`, `model`, `resumed` (bool), `pid`, `caps` (v2) | Al arrancar o reanudar, antes del primer `ready` |
| `ready` | — | El prompt acepta entrada: tras el arranque y tras cada `turn_end` cuando no queda nada en cola |
| `turn_start` | `source` (`user` \| `queued` \| `scheduled`) | Empieza un turno del modelo |
| `turn_end` | `reason` (`completed` \| `interrupted` \| `error`) | Termina el turno |
| `ask_user` | `tool_use_id`, `questions` (lista de `{header, question, multiSelect, options:[{label, description}]}`) | La herramienta `AskUserQuestion` muestra su diálogo; sustituye al texto `Enter to select` |
| `ask_user_done` | `tool_use_id`, `answered` (bool) | El diálogo se cerró (respondido o descartado) |
| `permission_prompt` | `tool_use_id`, `tool`, `summary` | Aparece un diálogo de permiso (en modo bypass nunca se emite) |
| `input_queued` | `id`, `text_len` | Llegó una entrada por `FNHARNESS_INPUT` mientras el modelo trabajaba |
| `input_accepted` | `id`, `text_len` | Una entrada por `FNHARNESS_INPUT` se envió como prompt |
| `session_switch` | `old_session_id`, `new_session_id`, `reason` (`clear` \| `resume` \| `compact`) | Cambió el `session_id`; sustituye al hook `SessionStart` que hoy apunta el id nuevo en el state file. fnharness conserva el id al compactar, así que hoy solo emite `clear` y `resume`; `compact` queda reservado |
| `entry` (v2) | `entry` (objeto), `input_id?` (cadena), `truncated?` (`true`) | Se añade una entrada al transcript principal de la sesión (detalle abajo) |
| `mcp_settled` (v2) | `connected`, `failed`, `pending` (enteros) | Terminó la conexión inicial de los servidores MCP, una sola vez por proceso |
| `exit` | `code` | El proceso termina |

Garantías de orden: `session_start` es el primer evento; `ready` nunca se emite entre `turn_start` y
`turn_end`; todo `ask_user` va seguido de su `ask_user_done`; `exit` es el último. En v2: las `entry` de un
turno, incluida `system/turn_duration`, van antes de su `turn_end`.

### `session_start.caps` (v2)

Lista de capacidades del proceso; el puente activa cada modo solo si aparece. Una lista ausente (emisor v1)
equivale a `[]`.

| Capacidad | Significado |
|---|---|
| `entries` | El proceso emite `entry` con el transcript principal: el puente no tiene que leer el JSONL |
| `mcp` | El proceso emite `mcp_settled` y retiene el primer `ready` hasta entonces. Solo en modo interactivo (la TUI monta el gestor de MCP); en `-p` no aparece y `mcp_settled` no se emite |

### `entry` (v2)

```json
{"type":"entry","entry":{...},"input_id":"br-17","truncated":true}
```

- `entry`: el objeto que se añade al transcript principal (`assistant`, `user`, `system`, `attachment`,
  `queue-operation`, `ai-title`, `summary`…), con los mismos campos que la línea del fichero JSONL de la
  sesión (`uuid`, `parentUuid`, `sessionId`, `timestamp`, `message`…). Es el mismo objeto que lee hoy el
  puente con `ParseLine`, así que se puede pasar tal cual a ese lector.
- Se emite en el momento en que la entrada se encola para escribirse, sin esperar al volcado por lotes de
  100 ms del fichero, y en el mismo orden que en el fichero. Una sola emisión por entrada: las entradas que
  esperan a que exista el fichero de la sesión se emiten al escribirse, no antes, y las que el
  transcript descarta por uuid repetido no se emiten.
- Solo el transcript principal de la sesión vigente: no se emiten los de subagentes (`isSidechain`), ni el
  fichero de otra sesión. No se emiten los metadatos que fnharness reescribe al final del fichero para
  refrescar la cola (`last-prompt`, `custom-title`, `tag`, `mode`…); el título generado por el modelo
  (`ai-title`) sí.
- `session_id` del evento es la sesión vigente: tras `/clear` o `/resume` las `entry` siguen en el mismo
  fichero con el `session_id` nuevo (precedidas por `session_switch`).
- `input_id`: si el prompt llegó por `FNHARNESS_INPUT`, la entrada `user` de ese prompt lleva el `id` de la
  línea `prompt` (el mismo que en `input_accepted`). Se estampa una sola vez, en la entrada cuyo `uuid` es el
  del mensaje inyectado; no hace falta comparar textos.
- `truncated: true` aparece cuando `entry` se recortó (reglas siguientes).

**Recorte.** Para que ninguna línea supere el límite de 1 MB del lector (que descartaría el evento):

- El texto de un `tool_result` de más de 8 KB (8192 caracteres) se corta y termina en
  `[… recortado: N caracteres más]`. Vale para el `content` en cadena y para cada parte `text` de un
  `content` en lista.
- Un bloque `image` con `source.type == "base64"` se sustituye por
  `{"type":"text","text":"[imagen omitida: <media_type>, <n> caracteres base64]"}`.
- La línea final nunca pasa de unos 900 KB: si varios resultados suman más, el corte se estrecha
  (4 KB, 2 KB…) y, en último caso, se descarta `toolUseResult` y se sustituye el `content` por un marcador.
  Un resultado de 5 MB llega, por tanto, recortado; nunca se pierde el evento.
- El recorte no muta la entrada original (el fichero JSONL conserva el resultado completo).
- Una entrada que no necesita recorte se emite tal cual y sin `truncated`.

**Orden de `turn_end`.** El REPL graba los mensajes desde un efecto que corre después de terminar el turno,
y `system/turn_duration` (turnos de 30 s o más) se añade después de `turn_end`. Para cumplir la garantía,
`turn_end` (y el `ready` que le sigue) espera, hasta 3 s, a que terminen las grabaciones del transcript en
curso y, si el turno duró más de unos 29 s, hasta 1,5 s a que llegue su `turn_duration`. Un `turn_end`
pendiente sale siempre antes del `turn_start` siguiente y antes de `exit`.

### `mcp_settled` (v2)

Se emite una sola vez por proceso, cuando terminan todos los intentos de conexión iniciales de los servidores
MCP (los de configuración y los de claude.ai): `connected` (conectados), `failed` (fallidos, incluidos los
que piden autenticación) y `pending` (sin respuesta; 0 salvo que venza el tope de 60 s, que libera el
canal igualmente). Sin servidores configurados se emite en cuanto el gestor lo sabe, con todo a 0.

Con la capacidad `mcp`, el proceso retiene `ready` y las entradas encoladas por `FNHARNESS_INPUT` hasta
emitir `mcp_settled`: el puente no habla con un modelo sin las herramientas MCP conectadas. Va, por tanto,
antes del primer `ready`.

Notas de implementación:

- `ready` se emite una vez por periodo ocioso (el prompt sin turno, sin interfaz de comando local y sin
  nada en cola) y se repite tras cada `turn_end` que deja el prompt libre. Si había entradas encoladas
  por `FNHARNESS_INPUT`, en su lugar se emite `input_accepted` de la siguiente y `ready` espera.
- Un turno interrumpido con Escape emite `turn_end` con `reason: "interrupted"` antes del `ready`
  siguiente, aunque el prompt ya esté libre.
- `turn_start.source`: `user` (tecleado o entrada del FIFO con el prompt libre), `queued` (esperó en
  una cola, la del FIFO o la del REPL) o `scheduled` (notificaciones y prompts meta).
- `permission_prompt.summary` es la descripción del diálogo, aplanada y cortada a 200 caracteres.
- En modo `-p` se emiten `session_start`, `turn_start`, `turn_end`, `ready` (al quedar la cola vacía) y
  `exit`; `FNHARNESS_INPUT` solo se lee en modo interactivo.

## Canal de entrada: `FNHARNESS_INPUT`

Ruta de un FIFO (`mkfifo`) que crea el lanzador. fnharness lo abre en lectura no bloqueante y procesa
una línea JSON por mensaje. El puente escribe cada línea completa con un único `write`.

| `type` | Campos | Efecto |
|---|---|---|
| `prompt` | `id`, `text` | Envía `text` como si el usuario lo hubiera tecleado y pulsado Enter. Si el modelo está trabajando, se encola (`input_queued`) y se envía cuando acabe el turno |
| `ask_answer` | `tool_use_id`, `selected` (lista de `label`), `text` (respuesta libre, opcional), `answers` (opcional) | Responde al diálogo abierto de `AskUserQuestion`; `selected` y `text` son excluyentes salvo en multiselección |
| `interrupt` | — | Equivale a Escape: interrumpe el turno en curso |

Reglas de `ask_answer`: con una sola pregunta, `selected` lleva el `label` elegido (en multiselección,
varios, que se unen con `, `, y `text` se añade como una opción más); `text` solo es la respuesta libre
("Other"). Con varias preguntas, `selected[i]` responde a la pregunta `i`. La extensión opcional
`answers` (`{ "<texto de la pregunta>": "<respuesta>" }`) responde a todas por texto y tiene prioridad;
es un campo añadido y opcional. Si no hay un diálogo abierto con ese
`tool_use_id`, la línea se descarta con log de depuración.

Una línea que no sea JSON válido o con `type` desconocido se descarta y se registra en el log de
depuración; nunca tumba la sesión.

## `--fork-session`

Un proceso lanzado con `--fork-session` borra `FNHARNESS_EVENTS` y `FNHARNESS_INPUT` de su entorno al
arrancar: un fork no hereda el canal de la sesión de la que sale (escribiría en su fichero de eventos y
leería su FIFO). El lanzador que quiera un canal para el fork debe pasar variables propias.

## Compatibilidad con el puente actual

El puente decide por sesión: si existe el fichero de eventos de esa sesión usa este contrato; si no,
mantiene el comportamiento actual (scraping de pantalla y `paste-buffer`). Así conviven agentes en
`claude` y en `fnharness` sin ramas de código especiales.

## Ejemplo

Un turno de v2 con texto, una herramienta y su resultado (los campos de cada `entry` se abrevian):

```jsonl
{"v":2,"seq":1,"ts":"2026-11-13T17:02:11.120Z","session_id":"6f1c...","type":"session_start","cwd":"/home/user/fn_registry/.claude/worktrees/lista-compra","account":"claude","model":"claude-sonnet-5-5","resumed":false,"pid":4242,"caps":["entries","mcp"]}
{"v":2,"seq":2,"ts":"2026-11-13T17:02:11.900Z","session_id":"6f1c...","type":"mcp_settled","connected":2,"failed":0,"pending":0}
{"v":2,"seq":3,"ts":"2026-11-13T17:02:11.910Z","session_id":"6f1c...","type":"ready"}
{"v":2,"seq":4,"ts":"2026-11-13T17:02:20.300Z","session_id":"6f1c...","type":"input_accepted","id":"br-1","text_len":22}
{"v":2,"seq":5,"ts":"2026-11-13T17:02:20.310Z","session_id":"6f1c...","type":"turn_start","source":"user"}
{"v":2,"seq":6,"ts":"2026-11-13T17:02:20.330Z","session_id":"6f1c...","type":"entry","entry":{"type":"user","uuid":"b1...","parentUuid":null,"sessionId":"6f1c...","timestamp":"2026-11-13T17:02:20.320Z","message":{"role":"user","content":"lista los ficheros"}},"input_id":"br-1"}
{"v":2,"seq":7,"ts":"2026-11-13T17:02:23.100Z","session_id":"6f1c...","type":"entry","entry":{"type":"assistant","uuid":"c2...","parentUuid":"b1...","sessionId":"6f1c...","message":{"role":"assistant","content":[{"type":"text","text":"Miro el directorio."},{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}}
{"v":2,"seq":8,"ts":"2026-11-13T17:02:23.900Z","session_id":"6f1c...","type":"entry","entry":{"type":"user","uuid":"d3...","parentUuid":"c2...","sessionId":"6f1c...","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"a.txt\nb.txt\n[… recortado: 20480 caracteres más]"}]}},"truncated":true}
{"v":2,"seq":9,"ts":"2026-11-13T17:02:26.400Z","session_id":"6f1c...","type":"entry","entry":{"type":"assistant","uuid":"e4...","parentUuid":"d3...","sessionId":"6f1c...","message":{"role":"assistant","content":[{"type":"text","text":"Hay dos ficheros."}],"stop_reason":"end_turn"}}}
{"v":2,"seq":10,"ts":"2026-11-13T17:02:51.500Z","session_id":"6f1c...","type":"entry","entry":{"type":"system","subtype":"turn_duration","uuid":"f5...","durationMs":31200,"sessionId":"6f1c..."}}
{"v":2,"seq":11,"ts":"2026-11-13T17:02:51.540Z","session_id":"6f1c...","type":"turn_end","reason":"completed"}
{"v":2,"seq":12,"ts":"2026-11-13T17:02:51.550Z","session_id":"6f1c...","type":"ready"}
```

Y la pregunta con diálogo de la v1, que no cambia (salvo `v`):

```jsonl
{"v":2,"seq":20,"ts":"2026-11-13T17:03:24.771Z","session_id":"6f1c...","type":"ask_user","tool_use_id":"toolu_02","questions":[{"header":"Tienda","question":"¿Dónde compro?","multiSelect":false,"options":[{"label":"Mercadona","description":""},{"label":"Dia","description":""}]}]}
{"v":2,"seq":21,"ts":"2026-11-13T17:03:31.002Z","session_id":"6f1c...","type":"ask_user_done","tool_use_id":"toolu_02","answered":true}
```
