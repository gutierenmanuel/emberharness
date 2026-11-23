---
name: fnharness
lang: ts
domain: ai
version: 0.1.0
description: "Harness de agente de terminal (fork de Claude Code sobre Bun/Ink) que funciona con cualquier proveedor de LLM, no solo Anthropic. Un adaptador traduce la API Messages de Anthropic a OpenAI Chat Completions (streaming, tool calls, imágenes, razonamiento), de modo que herramientas, subagentes, MCP, hooks y skills corren igual sobre llama.cpp, Ollama, LM Studio, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, Mistral, Together o cualquier endpoint compatible. El comando /account cambia de cuenta en caliente, guarda claves en ~/.fnharness/accounts.json con modo 0600 y recuerda la última usada. Tiene estado propio en ~/.fnharness, separado de ~/.claude, y statusbar propio que muestra la cuenta activa y el comando fnharness --resume."
tags: [harness, agent, cli, llm, multimodel, openai-compatible, llama-cpp, ollama, claude-code, statusline]
uses_functions: []
uses_types: []
framework: "bun-ink"
entry_point: "bin/emberh"
dir_path: "apps/fnharness"
repo_url: "https://gitea-dgg044oo04woo4ggcsws4gk0.organic-machine.com/dataforge/emberharness"
e2e_checks:
  - id: unit
    cmd: "cd apps/fnharness && PATH=$HOME/.local/bun-npm/node_modules/.bin:$PATH bun test src scripts"
    timeout_s: 120
  - id: e2e
    cmd: "cd apps/fnharness && PATH=$HOME/.local/bun-npm/node_modules/.bin:$PATH bun run test:e2e"
    timeout_s: 400
  - id: accounts
    cmd: "apps/fnharness/bin/emberh --accounts"
    expect_stdout_contains: "llamacpp"
    timeout_s: 20
---

# fnharness

Lanzador: `emberh` (symlink en `~/.local/bin` a `bin/emberh`; `fnharness` queda como alias).

```bash
fnharness                          # sesión interactiva con la última cuenta usada
fnharness --resume <session_id>    # retomar sesión
fnharness --account llamacpp       # arrancar con una cuenta concreta (no se guarda)
fnharness --account ollama --model qwen3:8b -p "..."
fnharness --accounts               # cuentas disponibles
fnharness --perfil minimo          # perfil de contexto (full, simple, minimo, chat o uno propio)
```

## /account

| Comando | Efecto |
|---|---|
| `/account` | selector interactivo con estado (✓ listo, ✗ falta clave, ○ servidor local apagado) |
| `/account list` | lo mismo en texto |
| `/account <id> [modelo]` | cambia de cuenta y, opcional, de modelo; se recuerda para el próximo arranque |
| `/account key <id> <apikey>` | guarda la clave en `~/.fnharness/accounts.json` (0600); también vale la variable `OPENAI_API_KEY`, etc. |
| `/account add <id> <baseUrl> [modelo]` | cuenta propia OpenAI-compatible |
| `/account remove <id>` | borra lo guardado de esa cuenta |

La cuenta `claude` usa la API nativa de Anthropic; el login es propio de fnharness (`/login` la primera vez), no se comparte con `~/.claude`.

## /perfil

| Comando | Efecto |
|---|---|
| `/perfil` | selector con descripción y coste aproximado en tokens de cada perfil |
| `/perfil <nombre>` | aplica el perfil (en caliente; con bare o hooks apagados → encendidos reinicia la sesión vía el lanzador) |
| `/perfil nuevo <nombre>` | guarda lo que tiene la sesión como `<config>/profiles/<nombre>.json` y muestra la ruta |

Un perfil agrupa system prompt, herramientas y contexto (CLAUDE.md, memoria, hooks, MCP, skills), más cuenta y modelo opcionales. Fábrica: `full`, `simple`, `minimo`, `chat`. Detalle y formato: `docs/COMMANDS.md` sección 2.14.

## Piezas

- `src/services/api/openai-compat/`: `profiles.ts` (presets y perfil activo), `accounts.ts` (almacén de cuentas), `translate.ts`, `stream.ts`, `adapter.ts`.
- `src/commands/account/`: el comando `/account`.
- `src/utils/perfil.ts` (modelo puro), `perfilStore.ts` (fábrica, usuario y estado), `perfilRuntime.ts` (aplicar en caliente), `perfilRestart.ts` y `src/commands/perfil/`: los perfiles de contexto.
- `src/utils/sessionDirectory/` (directorio de sesiones de toda la máquina: `merge`, `origin`, `actions`, `rows` puros; `sources` y `jump/*` con efectos), `src/components/sessions/` (selector con ← y `ctrl+x ctrl+w`) y `src/commands/sesiones/` (`/sesiones`).
- `statusline.sh`: statusbar propio (copia adaptada del de Claude Code; sin sidecars de agentsadmin; muestra `[cuenta]`).
- `docs/COMMANDS.md` y `docs/EDITING.md`: catálogo de comandos y guía para modificar el sistema.

Build: `PATH=$HOME/.local/bun-npm/node_modules/.bin:$PATH bun run build` (genera `./cli`, ignorado por git).

## Tests

- `bun run test:unit`: funciones puras y lógica de los módulos (`src/**/*.test.ts`, `scripts/*.test.ts`).
- `bun run test:e2e`: compila y conduce el `./cli` real (`tests/e2e/`). Un backend OpenAI falso responde a `-p`, y la TUI se captura en un pseudo-terminal (`script`) con `FNHARNESS_MOCKS` para comprobar cabecera, contadores y pie. No contacta con ningún proveedor real.
- Laboratorio visual: `bun run lab` (http://127.0.0.1:7700), la TUI real con un sidebar de mocks (`lab/README.md`).

## Versiones

`package.json` lleva la versión de FnHarness (`version`) y la del snapshot de Claude Code del que parte (`upstreamVersion`, que es la que viaja hacia Anthropic). Publicar: `bun run release patch|minor|major` (sube versión, escribe `CHANGELOG.md` y crea el tag).

## Notas

- El origen es un snapshot reconstruido de Claude Code: el repo se mantiene privado.
- El coste que muestra el statusbar usa tarifas de Anthropic; con proveedores locales o ajenos no es real.
