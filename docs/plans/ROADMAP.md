# Roadmap de fnharness (24/10/2026)

Plan para la siguiente tanda de mejoras. Cada bloque es una rama corta `quick/<slug>` en un
worktree del artefacto, con sus tests, que se integra en `master` con `merge --no-ff`. Los informes
de investigación que alimentan los bloques B y C están en `claude_code_gap.md` y
`opencode_models.md`, en esta misma carpeta.

| # | Bloque | Depende de | Tamaño |
|---|---|---|---|
| A | Versionado propio de fnharness | — | S |
| B | Funcionalidades de Claude Code que faltan (`/loop` y otras) | `claude_code_gap.md` | M-L |
| C | Catálogo de modelos de opencode (models.dev) | `opencode_models.md` | M |
| D | `/model` por cuenta | C | M |
| E | Contador de cuentas y modelos en la pantalla principal | D | S |
| F | Bienvenida mínima: solo tema | — | S |
| G | Modo mock + laboratorio HTML con sidebar | E (para mockear los contadores) | M |
| H | Tests: unitarios, de componentes y de snapshot de la TUI | G (reutiliza los mocks) | M |

Orden propuesto: A → F → C → D → E → G → H, con B en paralelo por funcionalidades sueltas.

## Estado (24/10/2026, v0.6.0)

| # | Estado |
|---|---|
| A | Hecho: versión propia en `package.json`, `scripts/release.ts`, `CHANGELOG.md`, tag `v0.5.0`. |
| B | Tandas 1 y 2 hechas: `/loop` fijo y autopaced, Cron, `ScheduleWakeup`, tool `Monitor` (probada con la cuenta claude). Tanda 3 hecha en v0.7.0: `/goal`, `fallbackModel` entre cuentas, hooks `PostToolBatch`/`DirectoryAdded`/`Pre`-`PostModelSwitch`, `--safe-mode`, `/cd`, `/recap`, `/autocompact`, `/reload-skills`; además `/account` con secciones y bypass en el ciclo de Shift+Tab. Pendientes en `claude_code_gap.md`. |
| C | Hecho: catálogo models.dev con snapshot embebido (202 proveedores, 5.653 modelos) y refresco diario. |
| D | Hecho: `/model` por cuenta, `/account catalog` y `/account add <proveedor>`. |
| E | Hecho: «N cuentas conectadas · M modelos», calculado antes de pintar la cabecera. |
| F | Hecho: el primer arranque solo pide tema (y confianza de carpeta). |
| G | Hecho: `FNHARNESS_MOCKS` y `bun run lab`. |
| H | Hecho: `test:unit` (93 tests) y `test:e2e` (binario real con backend falso y TUI en pseudo-terminal). |

## A. Versionado

Hoy `package.json` dice `2.1.87`, que es la versión del snapshot de Claude Code del que parte el
fork, y se inyecta en `MACRO.VERSION` desde `scripts/build.ts`. Esa cadena **no se puede cambiar
sin más**: viaja en el user-agent y en las cabeceras hacia Anthropic, y la usan las notas de
versión y las comprobaciones de versión mínima. Si la API ve una versión desconocida, el login con
la suscripción puede dejar de funcionar.

Diseño:

- `package.json` pasa a llevar la versión propia en `version` (empezamos en `0.5.0`) y la del
  upstream en un campo nuevo `upstreamVersion: "2.1.87"`.
- `scripts/build.ts` define `MACRO.VERSION = upstreamVersion` (todo lo que habla con Anthropic sigue
  igual) y un `MACRO.FNHARNESS_VERSION = version` nuevo.
- La cabecera muestra `FnHarness v0.5.0` y, atenuado, `· base 2.1.87`. `fnharness --version`
  imprime las dos.
- `scripts/release.ts patch|minor|major`: sube la versión en `package.json`, añade al
  `CHANGELOG.md` los commits convencionales desde el último tag, commitea `chore(release): vX.Y.Z`
  y crea el tag `vX.Y.Z`. SemVer: `feat:` sube minor y `fix:` sube patch mientras estemos en 0.x.
- El `changes.md` actual es el PR de Codex del repo origen; pasa a `docs/upstream_codex.md` para no
  confundirlo con el changelog propio.

## B. Funcionalidades de Claude Code que faltan

Detalle en `claude_code_gap.md` (comparado con Claude Code 2.1.309). El build por defecto solo
activa `VOICE_MODE`, así que mucho código existe pero sale apagado. Ya presentes y sin trabajo:
worktrees, `/rewind`, plugins, statusline, output styles, `/context`, `/stats`, LSP, ToolSearch y
hooks. Descartados por depender de Anthropic: `/schedule` en la nube, fast mode, `/advisor`,
`/usage` de plan, ultrareview, teleport/Remote Control y voz.

Tandas por prioridad:

1. **`/loop` + Cron + `ScheduleWakeup`**: activar `AGENT_TRIGGERS` (compila) en el build por
   defecto y escribir `ScheduleWakeup` y el modo autopaced, que faltan. S + M.
2. **Tool `Monitor`**: `MONITOR_TOOL` no compila porque falta `MonitorTool`; los ganchos en
   `LocalShellTask` ya están. M.
3. **`/goal`**: nuevo, sobre el hook `Stop` de tipo prompt, con cuenta elegible para el evaluador. M.
4. **`fallbackModel` en settings y hooks nuevos** (`PostToolBatch`, `PreModelSwitch`,
   `PostModelSwitch`…; hook `mcp_tool`): el fallback entre cuentas encaja con el multiproveedor. S.
5. **Pack de comodidad**: `/recap`, `/cd`, `/autocompact`, `/focus`, `/reload-skills`,
   `--safe-mode`. S cada uno.
6. **`/fork` y `/subtask`**: M.
7. **Sesiones en segundo plano** (`--bg`, `agents`, `attach`): L, o M para un MVP sin vista.
8. **Auto mode**: faltan los prompts del clasificador; con modelo local sería poco fiable. L, baja
   prioridad; alternativa `acceptEdits` + `/sandbox`.
9. **Workflows y mensajería entre sesiones**: L, baja prioridad.

## C. Catálogo de modelos de opencode

Detalle en `opencode_models.md`. opencode lee models.dev (`https://models.opencode.ai/api.json`,
espejo idéntico de `https://models.dev/api.json`): 230 proveedores y 8.881 modelos a 24/10/2026, de
los que 207 proveedores (5.724 modelos de chat con tools, no obsoletos) son OpenAI-compatibles y
fnharness puede usar ya. Pasos: `catalog.ts` puro + script de snapshot embebido → caché en
`~/.fnharness/models.json` (TTL 24 h, refresco en segundo plano; el arranque solo lee disco) →
`contextWindow`/`maxOutputTokens` por modelo desde el catálogo (el servidor local manda si dice
otra cosa) → `/model` (bloque D) → `/account catalog` y `/account add <proveedor>` para dar de alta
cualquier proveedor del catálogo → pulido (razonamiento, búsqueda, proveedores con protocolo
Anthropic).

Decisión pendiente: en modo multimodelo `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` está siempre
activo, así que el refresco del catálogo no correría nunca; el plan propone saltárselo solo para
ese fetch.

## D. `/model` por cuenta

Hoy `/model` lista los modelos de Claude (`getModelOptions` en `src/utils/model/modelOptions.ts`),
aunque la cuenta activa sea `qwen36` u `openrouter`.

- Nueva función `listAccountModels(account)` en `src/services/api/openai-compat/`: une el catálogo
  de C para ese proveedor con `GET {baseUrl}/models` del servidor (imprescindible en locales:
  llama.cpp, Ollama y LM Studio solo saben qué tienen cargado ellos), y cachea el resultado por
  cuenta.
- `getModelOptions` devuelve esa lista si hay perfil multimodelo activo; con la cuenta `claude`, la
  de siempre.
- Elegir un modelo en `/model` reutiliza lo que ya hace `/account <id> <modelo>` (persistido en
  `accounts.json`), así que el modelo elegido se recuerda por cuenta.
- La descripción de cada opción muestra contexto, salida máxima y coste si el catálogo lo tiene.

## E. Contadores en la pantalla principal

Debajo de la cabecera, antes de escribir nada: `3 cuentas conectadas · 47 modelos`.

- **Cuenta conectada** = la misma regla que ya pinta `/account` con ✓ (clave presente, o servidor
  local que responde). El sondeo de servidores locales se hace en segundo plano con timeout corto
  (300 ms) para no frenar el arranque; mientras tanto se muestra `…`.
- **Modelos** = suma de `listAccountModels` de las cuentas conectadas (cacheado por D).
- Va en `CondensedLogo` como cuarta línea atenuada y se congela con `OffscreenFreeze` igual que el
  resto de la cabecera.

## F. Bienvenida mínima

El onboarding (`src/components/Onboarding.tsx`) tiene los pasos `preflight`, `theme`, `oauth`,
`api-key`, `security` y `terminal-setup`. Se queda solo `theme`, más una línea final con el atajo
`/account` para conectar cuentas. El login de Claude deja de ser obligatorio en el primer arranque
(fnharness puede arrancar con una cuenta local) y pasa a hacerse bajo demanda con `/login` o
`/account claude`. `WelcomeV2` (la pantalla «Welcome to FnHarness» con el dibujo grande) se
mantiene encima del selector de tema.

## G. Modo mock y laboratorio HTML

Objetivo: ver cómo se comporta la TUI de verdad (no un dibujo) con estados difíciles de provocar a
mano.

- **Modo mock en fnharness**: si existe `FNHARNESS_MOCKS=<ruta.json>`, un módulo
  `src/dev/mocks.ts` vigila ese fichero (`fs.watch`) y aplica cada cambio sobre el AppState: N
  shells, monitors y agentes falsos en la pastilla de tareas, modo de permisos, cuentas y modelos
  conectados (E), spinner con texto, porcentaje de contexto, notificaciones y mensajes de error.
  Sin la variable, el módulo no hace nada; además va detrás de `feature('FNHARNESS_MOCKS')`, que
  solo activa `build:dev`.
- **Laboratorio**: `apps/fnharness/lab/` con un servidor Bun pequeño (`lab/server.ts`) que
  1. lanza `ttyd` en 127.0.0.1 con `fnharness` en modo mock (ttyd ya está instalado; lo usa
     `llm-terminal`), y
  2. sirve `lab/index.html`: la terminal real embebida a la izquierda (iframe de ttyd) y un sidebar
     a la derecha con botones e interruptores (modo, spinner, cuenta, error) y sliders (shells,
     monitors, agentes, cuentas, modelos, contexto %, ancho de terminal). Cada cambio hace `POST
     /mocks` y el servidor reescribe el JSON, que fnharness recoge en caliente.
- Un HTML estático sin TUI real se descarta: duplicaría el render de Ink y se desincronizaría.

## H. Tests

**Estado actual**: 2 ficheros de test, `src/services/api/openai-compat/openai-compat.test.ts` y
`accounts.test.ts`, con 12 tests que pasan (`bun test src/services/api/openai-compat`). Solo cubren
el adaptador y el almacén de cuentas. Del resto (UI, comandos, cabecera, pie) no hay nada; el
`e2e_checks` de `app.md` solo corre esos tests y `fnharness --accounts`.

Plan en tres capas:

1. **Unitarios** (`bun test`, sin UI): funciones puras como `getPillLabel`, `resolveProfile` con
   `contextWindow`, `listAccountModels` con `fetch` simulado, el bump de versión de `release.ts` y
   el parser del catálogo de models.dev.
2. **Componentes Ink**: renderizar `CondensedLogo`, `PromptInputFooterLeftSide` y
   `BackgroundTaskStatus` a texto con `ink-testing-library` (o con el renderer propio de
   `src/ink`), con AppState sembrado, y comparar con snapshots.
3. **Snapshot de la TUI real**: arrancar el binario en un pseudo-terminal (`script -qc` o
   `Bun.spawn` con pty) con `FNHARNESS_MOCKS` y un proveedor OpenAI falso (un servidor Bun que
   responde streams fijos), quitar los códigos ANSI y comparar el primer frame y el pie con
   ficheros dorados en `tests/golden/`. Es lo que se ha hecho a mano en esta sesión para validar
   la cabecera y el pie.

`package.json` gana `"test": "bun test"` y `app.md` declara las tres capas en `e2e_checks`.
