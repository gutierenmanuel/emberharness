# FnHarness

Arnés de agente de terminal (fork de Claude Code sobre Bun e Ink) que funciona con cualquier
proveedor de LLM, no solo Anthropic. Un adaptador traduce la API Messages de Anthropic a OpenAI Chat
Completions (streaming, tool calls, imágenes y razonamiento), de modo que herramientas, subagentes,
MCP, hooks y skills corren igual sobre llama.cpp, Ollama, LM Studio, OpenAI, OpenRouter, Groq,
DeepSeek, Gemini, Mistral, Together, Venice o cualquier endpoint compatible.

Es el arnés que se prepara como alternativa a `claude` para las salas de Matrix del ecosistema
fn_registry (ver [plan de arnés por defecto en Matrix](docs/plans/matrix_default_harness.md)).

Estado propio en `~/.fnharness`, separado de `~/.claude`. Repo privado: el origen es un snapshot
reconstruido de Claude Code y no se publica ni se redistribuye.

## Instalación

Requisitos: Linux, `git`, `bun` >= 1.3.11 y acceso al repo de Gitea.

```bash
git clone https://github.com/gutierenmanuel/fnharness$1
cd fnharness
./install.sh        # bun install, build de ./cli y enlace en ~/.local/bin/fnharness
```

`install.sh` acepta `FNHARNESS_DIR` (ruta de instalación), `FNHARNESS_REPO` (remoto) y
`FNHARNESS_LINK_DIR` (dónde enlazar el comando).

`Grep` y `Glob` necesitan `ripgrep`, y dentro de `./cli` no hay uno embebido. fnharness usa primero un
`rg` real del PATH (un archivo ejecutable: una función de shell llamada `rg` no cuenta) y, si no hay,
`vendor/ripgrep/<arq>-<so>/rg` junto al binario, que `install.sh` descarga con
`scripts/install-ripgrep.sh` (release oficial, sha256 verificado, sin `sudo` ni paquetes del sistema;
`vendor/` está en `.gitignore`). `FNHARNESS_RG=/ruta/rg` fuerza otro binario.

## Uso

```bash
fnharness                          # sesión interactiva con la cuenta predeterminada (o, si no hay, la última usada)
fnharness --resume <session_id>    # retomar una sesión
fnharness --account llamacpp       # arrancar con una cuenta concreta (no se guarda)
fnharness --account ollama --model qwen3:8b -p "resume este repo"
fnharness --accounts               # cuentas, la predeterminada, la última usada y con cuál abrirá
fnharness --set-default qwen36     # fija la cuenta con la que abre (opcional: modelo detrás)
fnharness --set-default last       # sin predeterminada: vuelve a «la última usada»
```

Dentro de la sesión:

| Comando | Efecto |
|---|---|
| `/account` | Selector de cuentas con su estado (listo, falta clave, servidor local apagado) |
| `/account <id> [modelo]` | Cambia de cuenta y, opcionalmente, de modelo |
| `/account default <id\|last> [modelo]` | Fija la cuenta (y modelo) con la que abre fnharness; `last` la quita |
| `/model` | Modelos de todas las cuentas conectadas; `cuenta:modelo` fuerza una cuenta para esa petición |
| `/scope` | Qué llega al modelo: servidores MCP, skills y herramientas (perfil de contexto por cuenta) |
| `/goal`, `/loop` | Mantener al agente trabajando hasta cumplir una condición, y tareas recurrentes |
| `/background <prompt>` (`/bg`) | Lanza una sesión en segundo plano que continúa esta conversación; se gestiona con `fnharness ps\|logs\|stop\|attach\|rm` |

El catálogo completo está en [docs/COMMANDS.md](docs/COMMANDS.md). La cuenta `claude` usa la API
nativa de Anthropic; su login (`/login`) es propio de fnharness.

## Cuenta con la que abre

Orden de decisión al arrancar: `--account` > **predeterminada** (`default` en `accounts.json`) >
**última usada** (`active`, la escribe cada cambio de cuenta) > `claude`. La predeterminada es opt-in:
sin ella todo sigue como antes (se abre con la última usada). Se fija con `/account default <id>
[modelo]` o `fnharness --set-default <id> [modelo]` (el modelo queda guardado como el de esa cuenta);
`last` o `none` la borran. Cambiar de cuenta dentro de una sesión no mueve la predeterminada, solo la
«última usada». Si la predeterminada deja de existir (se borra la cuenta) se salta y se usa la última.
`fnharness --accounts` y `/account list` marcan cuál es y con cuál abrirá.

## Barra de estado

`statusline.sh` recibe por stdin el JSON de siempre más un bloque `fnharness` que se calcula con la
cuenta activa (nada de supuestos de Claude): `account` (id, etiqueta, proveedor, URL, modelo, nombre
que da el servidor), `context` (ventana real, de dónde sale: `server`, `preset`, `catalog` o `claude`,
umbral de autocompactación y tope de salida), `server` (si responde y su `n_ctx`), `speed` (último
turno medido, mismo formato que `local_speed`) y `cost` (`subscription`, `free`, `priced`,
`unpriced`). Ejemplo con la cuenta `qwen36`:

```
qwen36-35b-heretic-q4km [qwen36] │ CTX: █░░░░░░░░░ 10% (3k/32k) ⟳25.8k │ IN:3k OUT:5 │ ⎇ master │ 15:55
local · sin coste │ +0/-0 │ Total: ↓3k/↑21 │ ⏱ 13s │ ~/proyecto
qwen36 Qwen3.6 35B heretic (local) @ localhost:8090 ● en línea │ ventana 32k (servidor) · salida máx 4k · autocompacta a 25.8k │ ⚡ TTFT 9.47 s · gen 29.3 tok/s · lectura 172 tok/s · espec. 50%
```

Con `claude` la tercera línea es `claude Anthropic │ ventana 200k · salida máx 32k · autocompacta a
167k` y se mantienen coste y límites 5h/7d (que no se muestran en el resto de cuentas). La ventana de
un servidor local sale de `GET /props` (`n_ctx` por slot, llama.cpp) y **gana** al preset, además de
alimentar el autocompactado; si no hay tope de salida y la ventana es corta (≤ 64k) se usa un cuarto
de ella. La consulta es una sola petición en segundo plano con TTL (15 s en línea, 4 s caído), no
bloquea el refresco; `FNHARNESS_SERVER_PROBE=0` la desactiva. Para que la barra se actualice sola
cada 2 s, el `settings.json` necesita `"refreshInterval": 2` en `statusLine` (el lanzador lo escribe
solo en instalaciones nuevas).

## Canal de eventos para Matrix

Dos variables de entorno, apagadas por defecto (sin ellas fnharness no escribe ni lee nada). El
contrato completo, con todos los eventos y campos, está en [docs/matrix_events.md](docs/matrix_events.md).

| Variable | Qué hace |
|---|---|
| `FNHARNESS_EVENTS=<ruta>.jsonl` | Añade una línea JSON por evento (`session_start`, `ready`, `turn_start`, `turn_end`, `ask_user`, `ask_user_done`, `permission_prompt`, `input_queued`, `input_accepted`, `session_switch`, `exit`). Se abre en modo append con permisos 0600 y cada línea es un único `write`. |
| `FNHARNESS_INPUT=<fifo>` | FIFO (`mkfifo`) del que se lee una línea JSON por mensaje: `prompt`, `ask_answer`, `interrupt`. Solo en modo interactivo. Las líneas inválidas se descartan con un log de depuración. |

```bash
mkfifo /tmp/fnh.in
FNHARNESS_EVENTS=/tmp/fnh.events.jsonl FNHARNESS_INPUT=/tmp/fnh.in fnharness &
tail -f /tmp/fnh.events.jsonl &
echo '{"type":"prompt","id":"1","text":"resume este repo"}' > /tmp/fnh.in
```

La lógica pura (construcción y serialización de eventos, parseo de la entrada, cola) está en
`src/utils/matrixEvents.ts`; los efectos (fichero, FIFO, enganches al REPL) en
`src/utils/matrixEventsRuntime.ts`.

## Velocidad del modelo local

Con una cuenta local (`baseUrl` en `localhost`/`127.0.0.1`: llama.cpp, qwen36, ollama, LM Studio)
aparece, tenue bajo la respuesta de cada turno, una línea como:

```
⚡ TTFT 0.42 s · lectura 1500 tok/s (300 tok, 2800 en caché) · generación 42.0 tok/s (210 tok) · especulación 75% (90/120)
```

Usa el objeto `timings` de llama-server (`prompt_n`, `prompt_ms`, `cache_n`, `predicted_n`,
`predicted_ms`, `draft_n`, `draft_n_accepted`); si el servidor no lo da cae a lo medido en el cliente
(TTFT y tokens de `usage`) y añade «medido en cliente». En un turno con varias peticiones (bucle de
herramientas) se agregan; las consultas auxiliares sin herramientas se descartan. En
`-p --output-format json` el resultado lleva el campo `local_speed`. `FNHARNESS_LOCAL_SPEED=0` lo
desactiva. Código: `src/services/api/openai-compat/speedStats.ts`.

## Modo ligero para cuentas locales

Una cuenta local (`baseUrl` en `localhost`, `127.0.0.1` o `[::1]`) tiene una ventana pequeña y un
primer token lento, así que arranca con una dieta de prompt. En `fn_registry` el prompt de una sesión
nueva baja de ~10,8k a ~1,3k tokens. Medidas y método: `reports/llm_speed_bench/prompt_diet/README.md`
del registry.

| Qué | Dónde aplica | Desactivar |
|---|---|---|
| `--setting-sources user` por defecto: sin los `CLAUDE.md` del proyecto, `.claude/rules` ni hooks de proyecto (el `CLAUDE.md` global sí) | cuentas locales | `FNHARNESS_LOCAL_LEAN=0`, o pasar `--setting-sources ...` explícito (siempre manda) |
| Sin `gitStatus` en el prompt de sistema | perfil Simple | (implícito) |
| `CLAUDE.md` de más de 4.000 caracteres (o por encima de 6.000 en total) se listan en una línea para leerlos con `Read` | perfil Simple | `FNHARNESS_LOCAL_MD_MAX_CHARS=0` |
| Descripciones de parámetros de los schemas: primera frase, máx. 90 caracteres | perfil Simple | `FNHARNESS_LOCAL_SCHEMA_DESC_MAX=0` |
| `Edit` sobre un archivo no leído lo da por leído en vez de fallar con «File has not been read yet» | solo cuentas locales; `claude` y las remotas conservan la protección original | (implícito) |
| Contexto estable (`CLAUDE.md`, fecha) antes de los adjuntos de hooks, para que la caché del prefijo sobreviva a un id de sesión nuevo | todas las cuentas | (implícito) |

`FNHARNESS_LOCAL_LEAN=0 fnharness --account qwen36` vuelve a cargar los ajustes y `CLAUDE.md` del
proyecto. Código: `src/services/api/openai-compat/leanLocal.ts`.

## Estructura

| Ruta | Contenido |
|---|---|
| `src/` | Código del arnés: `commands/`, `tools/`, `screens/REPL.tsx`, `services/api/openai-compat/` (adaptador multiproveedor) |
| `bin/fnharness` | Lanzador: fija `CLAUDE_CONFIG_DIR=~/.fnharness`, registra el statusbar y pasa los argumentos al CLI |
| `scripts/` | Build (`build.ts`), versionado (`release.ts`), backend OpenAI falso (`mock_openai.ts`), paridad de entorno con Claude Code (`sync_env.sh`, ver `docs/sync_env.md`) |
| `tests/e2e/` | Pruebas del binario real con backend falso y TUI en pseudo-terminal |
| `lab/` | Laboratorio visual de la TUI con datos simulados (`bun run lab`) |
| `docs/` | Comandos, guía de edición y planes de diseño (`docs/plans/`) |

## Desarrollo

```bash
export PATH="$HOME/.local/bun-npm/node_modules/.bin:$PATH"
bun install
bun run build         # genera ./cli
bun run test:unit     # pruebas unitarias (src y scripts)
bun run test:e2e      # compila y conduce el ./cli real
bun run lab           # http://127.0.0.1:7700
```

Flujo de ramas (trunk-based): `master` siempre desplegable; el trabajo va en ramas cortas
`quick/<slug>` o `issue/<NNNN>-<slug>`, cada una en su worktree dentro de `.claude/worktrees/`, con
commits convencionales y `merge --no-ff` a `master` tras pasar las pruebas. Detalle de cómo modificar
el sistema en [docs/EDITING.md](docs/EDITING.md).

## Versiones

`package.json` lleva la versión propia (`version`) y la del snapshot de Claude Code del que parte
(`upstreamVersion`, la que viaja hacia Anthropic). Publicar una versión:
`bun run release patch|minor|major` (sube la versión, actualiza `CHANGELOG.md` y crea el tag).

## Documentación de diseño

- [docs/plans/ROADMAP.md](docs/plans/ROADMAP.md): bloques de mejora y su estado.
- [docs/plans/matrix_default_harness.md](docs/plans/matrix_default_harness.md): plan para usar
  fnharness como arnés de las salas de Matrix.
- [docs/matrix_events.md](docs/matrix_events.md): contrato de eventos y entrada para el puente.
- [FEATURES.md](FEATURES.md): flags de compilación y funciones activadas.
