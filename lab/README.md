# Laboratorio de mocks de fnharness

Una página con fnharness real a la izquierda (ttyd embebido) y un sidebar a la derecha con
interruptores y sliders que activan mocks en la TUI sin tocar ningún estado real.

## Uso

```bash
bun run build          # el lab ejecuta bin/fnharness, que necesita ./cli
bun run lab            # abre http://127.0.0.1:7700
```

Variables opcionales: `LAB_PORT` (7700), `LAB_TTYD_PORT` (7690), `LAB_ACCOUNT` (qwen36), `LAB_CWD` (directorio de trabajo de la TUI; por defecto el árbol de fnharness. Si es un directorio sin confiar, la TUI pedirá confirmación dentro del iframe).
Todo escucha solo en 127.0.0.1. Ctrl+C para el servidor y ttyd.

## Cómo funciona

- `lab/server.ts` crea un `mocks.json` temporal, lanza `ttyd -W bin/fnharness --account <cuenta>` con
  `FNHARNESS_MOCKS=<ese json>` y sirve `lab/index.html`.
- `POST /mocks` valida el cuerpo (`src/dev/mocksCore.ts`) y reescribe el JSON de forma atómica;
  fnharness lo recoge en caliente (`src/dev/mocks.ts`). `POST /restart` relanza ttyd (cuerpo opcional
  `{"account": "..."}`). `GET /state` devuelve el estado actual.
- El modo mock funciona con el `./cli` normal; sin `FNHARNESS_MOCKS` no hace nada.

## Mocks soportados

| Campo | Efecto |
|---|---|
| `shells`, `monitors`, `agents` (0-5 en el lab) | tareas falsas en la pastilla del pie; abren el diálogo con ↓ + Enter |
| `permissionMode` | `default`, `acceptEdits`, `plan`, `bypassPermissions` (vacío = real) |
| `spinner` `{on, text}` | spinner activo con texto propio |
| `contextPct` (1-100) | fuerza «N% until auto-compact» del pie; en 0 vuelve el valor real |
| `notification` `{text, seq}` | notificación 8 s (cambia `seq` para repetir el mismo texto) |
| `error` `{text, seq}` | mensaje de error en el transcript |
| `accounts`, `models` | solo se publican en `globalThis.__FNHARNESS_MOCKS__`; aún no se pintan (bloque E) |

Notas: con una notificación activa se oculta el aviso de contexto del pie (comparten la misma
fila); los shells falsos no ejecutan nada ni se pueden parar de verdad.
