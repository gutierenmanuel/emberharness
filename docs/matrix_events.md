# Contrato de eventos y entrada para el puente de Matrix (v1)

Estado: implementado en fnharness (fase 2 de `docs/plans/matrix_default_harness.md`): emisor en
`src/utils/matrixEvents.ts` (lógica pura) y `src/utils/matrixEventsRuntime.ts` (efectos), tests en
`src/utils/matrixEvents.test.ts` y `tests/e2e/matrixEvents.e2e.test.ts`.
Quien cambie este documento sube `v` y actualiza a la vez el emisor (fnharness) y el lector (puente
`apps/agents_and_robots`, paquete `pkg/terminal`).

Motivo: el puente de Matrix lee de Claude Code el transcript JSONL (turnos, herramientas, tareas en
segundo plano) y, para lo que el transcript no cuenta, hace scraping de la pantalla con `tmux
capture-pane`: el diálogo de `AskUserQuestion` y la caja de entrada. Este contrato reemplaza ese
scraping por eventos estructurados. El transcript sigue siendo la fuente de verdad de los turnos; los
eventos solo cubren lo que el transcript no registra.

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
| `v` | entero | Versión del contrato (hoy `1`) |
| `seq` | entero | Contador monótono por proceso, desde 1; permite detectar huecos |
| `ts` | cadena | Instante ISO 8601 en UTC |
| `session_id` | cadena | UUID de la sesión vigente (cambia tras `/clear`, `/resume` o compactación) |
| `type` | cadena | Tipo de evento (tabla siguiente) |

Tipos de evento:

| `type` | Campos propios | Cuándo se emite |
|---|---|---|
| `session_start` | `cwd`, `account`, `model`, `resumed` (bool), `pid` | Al arrancar o reanudar, antes del primer `ready` |
| `ready` | — | El prompt acepta entrada: tras el arranque y tras cada `turn_end` cuando no queda nada en cola |
| `turn_start` | `source` (`user` \| `queued` \| `scheduled`) | Empieza un turno del modelo |
| `turn_end` | `reason` (`completed` \| `interrupted` \| `error`) | Termina el turno |
| `ask_user` | `tool_use_id`, `questions` (lista de `{header, question, multiSelect, options:[{label, description}]}`) | La herramienta `AskUserQuestion` muestra su diálogo; sustituye al texto `Enter to select` |
| `ask_user_done` | `tool_use_id`, `answered` (bool) | El diálogo se cerró (respondido o descartado) |
| `permission_prompt` | `tool_use_id`, `tool`, `summary` | Aparece un diálogo de permiso (en modo bypass nunca se emite) |
| `input_queued` | `id`, `text_len` | Llegó una entrada por `FNHARNESS_INPUT` mientras el modelo trabajaba |
| `input_accepted` | `id`, `text_len` | Una entrada por `FNHARNESS_INPUT` se envió como prompt |
| `session_switch` | `old_session_id`, `new_session_id`, `reason` (`clear` \| `resume` \| `compact`) | Cambió el `session_id`; sustituye al hook `SessionStart` que hoy apunta el id nuevo en el state file. fnharness conserva el id al compactar, así que hoy solo emite `clear` y `resume`; `compact` queda reservado |
| `exit` | `code` | El proceso termina |

Garantías de orden: `session_start` es el primer evento; `ready` nunca se emite entre `turn_start` y
`turn_end`; todo `ask_user` va seguido de su `ask_user_done`; `exit` es el último.

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
es un campo añadido y opcional, por lo que `v` sigue en 1. Si no hay un diálogo abierto con ese
`tool_use_id`, la línea se descarta con log de depuración.

Una línea que no sea JSON válido o con `type` desconocido se descarta y se registra en el log de
depuración; nunca tumba la sesión.

## Compatibilidad con el puente actual

El puente decide por sesión: si existe el fichero de eventos de esa sesión usa este contrato; si no,
mantiene el comportamiento actual (scraping de pantalla y `paste-buffer`). Así conviven agentes en
`claude` y en `fnharness` sin ramas de código especiales.

## Ejemplo

```jsonl
{"v":1,"seq":1,"ts":"2026-10-24T17:02:11.120Z","session_id":"6f1c...","type":"session_start","cwd":"/home/user/fn_registry/.claude/worktrees/lista-compra","account":"claude","model":"claude-sonnet-5-5","resumed":false,"pid":4242}
{"v":1,"seq":2,"ts":"2026-10-24T17:02:12.004Z","session_id":"6f1c...","type":"ready"}
{"v":1,"seq":3,"ts":"2026-10-24T17:02:20.310Z","session_id":"6f1c...","type":"turn_start","source":"user"}
{"v":1,"seq":4,"ts":"2026-10-24T17:02:24.771Z","session_id":"6f1c...","type":"ask_user","tool_use_id":"toolu_01","questions":[{"header":"Tienda","question":"¿Dónde compro?","multiSelect":false,"options":[{"label":"Mercadona","description":""},{"label":"Dia","description":""}]}]}
{"v":1,"seq":5,"ts":"2026-10-24T17:02:31.002Z","session_id":"6f1c...","type":"ask_user_done","tool_use_id":"toolu_01","answered":true}
{"v":1,"seq":6,"ts":"2026-10-24T17:02:35.640Z","session_id":"6f1c...","type":"turn_end","reason":"completed"}
{"v":1,"seq":7,"ts":"2026-10-24T17:02:35.650Z","session_id":"6f1c...","type":"ready"}
```
