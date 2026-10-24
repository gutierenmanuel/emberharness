# FnHarness

Arnés de agente de terminal (fork de Claude Code sobre Bun e Ink) que funciona con cualquier
proveedor de LLM, no solo Anthropic. Un adaptador traduce la API Messages de Anthropic a OpenAI Chat
Completions (streaming, tool calls, imágenes y razonamiento), de modo que herramientas, subagentes,
MCP, hooks y skills corren igual sobre llama.cpp, Ollama, LM Studio, OpenAI, OpenRouter, Groq,
DeepSeek, Gemini, Mistral, Together o cualquier endpoint compatible.

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

## Uso

```bash
fnharness                          # sesión interactiva con la última cuenta usada
fnharness --resume <session_id>    # retomar una sesión
fnharness --account llamacpp       # arrancar con una cuenta concreta (no se guarda)
fnharness --account ollama --model qwen3:8b -p "resume este repo"
fnharness --accounts               # cuentas disponibles
```

Dentro de la sesión:

| Comando | Efecto |
|---|---|
| `/account` | Selector de cuentas con su estado (listo, falta clave, servidor local apagado) |
| `/account <id> [modelo]` | Cambia de cuenta y, opcionalmente, de modelo |
| `/model` | Modelos de todas las cuentas conectadas; `cuenta:modelo` fuerza una cuenta para esa petición |
| `/scope` | Qué llega al modelo: servidores MCP, skills y herramientas (perfil de contexto por cuenta) |
| `/goal`, `/loop` | Mantener al agente trabajando hasta cumplir una condición, y tareas recurrentes |

El catálogo completo está en [docs/COMMANDS.md](docs/COMMANDS.md). La cuenta `claude` usa la API
nativa de Anthropic; su login (`/login`) es propio de fnharness.

## Estructura

| Ruta | Contenido |
|---|---|
| `src/` | Código del arnés: `commands/`, `tools/`, `screens/REPL.tsx`, `services/api/openai-compat/` (adaptador multiproveedor) |
| `bin/fnharness` | Lanzador: fija `CLAUDE_CONFIG_DIR=~/.fnharness`, registra el statusbar y pasa los argumentos al CLI |
| `scripts/` | Build (`build.ts`), versionado (`release.ts`), backend OpenAI falso (`mock_openai.ts`) |
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
