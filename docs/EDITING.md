# Modo edición del sistema

Guía práctica para modificar y extender este CLI (fork de Claude Code en Bun/TypeScript) de forma
segura, tanto para una persona como para un agente. Todas las rutas son relativas a la raíz del
repo y las líneas corresponden al estado del código cuando se escribió la guía; si editas esos
archivos, los números se desplazan, así que busca el símbolo con `grep -n`.

## 0. Preparación

```bash
export PATH="$HOME/.local/bun-npm/node_modules/.bin:$PATH"   # bun >= 1.3.11 (package.json:13)
bun install
bun run build          # genera ./cli (package.json:16, scripts/build.ts)
fnharness --list            # lista los presets de proveedor
```

Mapa mínimo de los archivos que más se tocan:

| Qué | Dónde |
|---|---|
| Registro de slash commands | `src/commands.ts` (754 líneas), implementaciones en `src/commands/` |
| Registro de tools | `src/tools.ts` (389 líneas), implementaciones en `src/tools/`, interfaz en `src/Tool.ts` |
| Tipo `Command` | `src/types/command.ts` |
| Proveedores no Anthropic | `src/services/api/openai-compat/` |
| Skills | `src/skills/` (`bundled/`, `bundledSkills.ts`, `loadSkillsDir.ts`) |
| Plugins | `src/plugins/builtinPlugins.ts`, `src/utils/plugins/` |
| Hooks | `src/utils/hooks.ts`, `src/utils/hooks/`, esquema en `src/schemas/hooks.ts` |
| Build y flags | `scripts/build.ts`, `FEATURES.md` |
| Lanzador | `mm` (script bash en la raíz) |

## 1. Añadir un slash command

El registro es la lista `COMMANDS` de `src/commands.ts:257`
(`const COMMANDS = memoize((): Command[] => [ ... ])`). Es una función memoizada a propósito: lee
config, y la config no se puede leer al inicializar el módulo (comentario en `src/commands.ts:255-256`).
`loadAllCommands` (`src/commands.ts:449`) concatena skills empaquetadas, skills de disco, plugins y
al final `COMMANDS()`; `getCommands(cwd)` (`src/commands.ts:476`) filtra por disponibilidad y
`isEnabled` en cada llamada.

El tipo está en `src/types/command.ts`: `Command = CommandBase & (PromptCommand | LocalCommand |
LocalJSXCommand)` (`src/types/command.ts:205`). `CommandBase` (`:175`) define `name`, `description`,
`aliases`, `isEnabled`, `isHidden`, `availability`, etc. Hay tres variantes:

- `local`: devuelve texto. Metadatos en `index.ts` y lógica cargada en diferido con `load`.
  Ejemplo mínimo real: `src/commands/clear/index.ts` (`type: 'local'`, `load: () => import('./clear.js')`).
  El módulo cargado exporta `call(args, context)` y devuelve `{ type: 'text' | 'compact' | 'skip' }`
  (`LocalCommandResult`, `src/types/command.ts:17`).
- `local-jsx`: renderiza UI Ink. Ejemplo: `src/commands/help/index.ts` + `help.tsx`.
- `prompt`: expande a un prompt para el modelo (`PromptCommand`, `src/types/command.ts:26`), con
  `getPromptForCommand`. Ejemplos de archivo suelto: `src/commands/commit.ts`, `src/commands/init.ts`.

Pasos:

1. Crea `src/commands/<nombre>/index.ts` con `satisfies Command` (patrón de `clear/index.ts`) y la
   implementación en un archivo hermano cargado con `load`. Mantén `index.ts` sin imports pesados:
   es lo que se evalúa al arrancar.
2. Añade el `import` junto a los demás (`src/commands.ts:2-58`) y el identificador dentro de
   `COMMANDS` (`src/commands.ts:257`).
3. Si el comando va tras un flag de compilación, usa el patrón de `require` condicional de
   `src/commands.ts:63-91` (ver sección 7) y no un `import` estático.
4. `supportsNonInteractive: false` si no tiene sentido con `-p`.
5. Para un comando que solo es un prompt reutilizable, suele bastar una skill (sección 4) sin tocar el
   registro.

Verificación: `bun run build && ./cli --help` y, en interactivo, escribir `/<nombre>`. Los cachés se
invalidan con `loadAllCommands.cache?.clear?.()` (`src/commands.ts:524`).

## 2. Añadir una tool

Interfaz: `Tool<Input, Output, P>` en `src/Tool.ts:362`. Miembros que importan:
`name` (`:456`), `inputSchema` (`:394`, zod), `call` (`:379`), `description` (`:386`), `prompt`
(`:518`), `isConcurrencySafe` (`:402`), `isReadOnly` (`:404`), `checkPermissions` (`:500`),
`mapToolResultToToolResultBlockParam` (`:557`) y `renderToolUseMessage` (`:605`).

No implementes `Tool` a mano: usa `buildTool` (`src/Tool.ts:783`), que rellena los valores por
defecto (`src/Tool.ts:745-765`): `isConcurrencySafe -> false`, `isReadOnly -> false` y
`checkPermissions -> allow` (delegando al sistema general de permisos). Marca `isReadOnly` y
`isConcurrencySafe` a `true` solo si es verdad: afecta a la ejecución en paralelo y a los permisos.

Estructura de referencia, `src/tools/GlobTool/`:

- `GlobTool.ts` (`buildTool({ name: GLOB_TOOL_NAME, ... })`, `:57`) con `inputSchema` envuelto en
  `lazySchema` y `z.strictObject` (`:21`).
- `prompt.ts`: `DESCRIPTION` y la constante del nombre.
- `UI.tsx`: renderizado del uso y del resultado.

Pasos:

1. Crea `src/tools/<Nombre>Tool/{<Nombre>Tool.ts,prompt.ts,UI.tsx}` imitando GlobTool.
2. Registra la tool en `getAllBaseTools()` (`src/tools.ts:193`), que es la lista maestra. Añade el
   import arriba. Las tools condicionales siguen el patrón `...(X ? [X] : [])`, con `X` obtenido por
   `require` bajo `feature(...)` o `process.env.USER_TYPE` (`src/tools.ts:20-60`).
3. `getTools(permissionContext)` (`src/tools.ts:271`) filtra por reglas de denegación
   (`filterToolsByDenyRules`, `:262`); `assembleToolPool` (`:345`) mezcla con las tools MCP. No hace
   falta tocarlas salvo que la tool tenga un modo propio (ver `REPL_ONLY_TOOLS`, `:148`).
4. Si el nombre debe tener tratamiento especial (permitida en subagentes, modo plan...), busca la
   constante del nombre de una tool vecina con `grep -rn GLOB_TOOL_NAME src` y replica los sitios.
5. Test: `bun test` con un archivo `*.test.ts` junto a la tool (el repo ya usa `bun:test`, ver
   `src/services/api/openai-compat/openai-compat.test.ts:1`).

Con un proveedor no Anthropic, el esquema zod acaba como JSON schema de `function` en
`translateTools` (`src/services/api/openai-compat/translate.ts:142`): evita esquemas con
construcciones que los backends pequeños no entiendan (uniones profundas, `$ref` recursivos).

## 3. Añadir un proveedor o backend

Arquitectura (todo en `src/services/api/openai-compat/`): el SDK de Anthropic se usa tal cual, pero
con un `fetch` propio que traduce `POST /v1/messages` a `POST {baseUrl}/chat/completions` y convierte
el SSE de vuelta a eventos de Anthropic.

Si el backend habla el formato OpenAI Chat Completions (lo habitual), solo hay que añadir un preset:

1. En `src/services/api/openai-compat/profiles.ts`, añade una entrada a `PROVIDER_PRESETS`
   (`profiles.ts:32`) con los campos de `ProviderPreset` (`profiles.ts:20-30`): `label`, `baseUrl`,
   `apiKeyEnv`, `keyOptional`, `defaultModel` y `maxTokensParam` (`max_completion_tokens` solo
   para OpenAI propiamente dicho, ver `profiles.ts:57-64`).
2. Respeta el formato de una línea `  nombre: {` con dos espacios: `fnharness --list` lo extrae con un `grep`
   sobre ese patrón (`mm:25`). Si cambias la indentación, el listado deja de funcionar.
3. La validación de clave ausente y de URL vacía ya la hace `resolveProfile` (`profiles.ts:142-180`) y
   lanza `MultimodelConfigError`; no la dupliques.
4. Añade un test en `openai-compat.test.ts` (bloque `resolveProfile`, `:7`).

Si el backend necesita lógica distinta (otro endpoint, otra autenticación, campos extra):

- `adapter.ts`: `createOpenAICompatFetch` (`adapter.ts:39`) decide el endpoint (`:40`), responde
  `/count_tokens` con una estimación de 4 caracteres por token (`:50-55`), construye cabeceras
  (`:67-72`) y traduce errores a respuestas Anthropic (`errorResponse`, `:18`).
- `translate.ts`: `translateMessages` (`:125`), `translateTools` (`:142`), `resolveModel` (`:164`),
  `translateRequest` (`:172`). Aquí se cambian parámetros del cuerpo (por ejemplo, si un backend
  rechaza `stream_options`).
- `stream.ts`: `parseSSE` (`:39`), `toAnthropicEvents` (`:65`), `collectMessage` (`:194`). Aquí se
  adaptan campos de delta no estándar (por ejemplo, `reasoning_content`).

Enganches fuera del directorio, que normalmente no hay que tocar pero conviene conocer:

- `src/entrypoints/cli.tsx:2,6`: `applyMultimodelEnv()` se ejecuta antes de cualquier otro import con
  efectos; fija `ANTHROPIC_MODEL` y compañía (`profiles.ts:~190-205`), un `ANTHROPIC_API_KEY`
  de relleno y desactiva telemetría. Debe seguir siendo lo primero.
- `src/services/api/client.ts:34-35` (imports) y `:309-317`: si hay perfil, devuelve un `Anthropic`
  con `fetch: createOpenAICompatFetch(profile)`. Esta rama va antes que la de Codex (`client.ts:319`).
- `src/utils/model/validateModel.ts` y `src/utils/logoV2Utils.ts` consultan `isMultimodelActive` /
  `getMultimodelProfile` para saltarse la validación de modelos de Anthropic y mostrar la etiqueta
  del backend.

Un backend con protocolo no OpenAI (por ejemplo, Gemini nativo) no cabe en un preset: haría falta
otro `createXFetch` y otra rama en `client.ts`, como la de Codex (`client.ts:319`).

Probar sin tocar un modelo real: el test `createOpenAICompatFetch (against a fake backend)`
(`openai-compat.test.ts:107`) levanta un backend falso. Extiéndelo en vez de apuntar a un servicio real.

## 4. Añadir una skill, un plugin o un hook

### Skill

- Del usuario o del proyecto, sin compilar: un `SKILL.md` en `.claude/skills/<nombre>/` (cargado por
  `getSkillDirCommands`, `src/skills/loadSkillsDir.ts:638`). Los `.md` sueltos solo se admiten en el
  directorio legado `/commands/` (`loadSkillsDir.ts:426` y `:482`).
- Empaquetada en el binario: crea `src/skills/bundled/<nombre>.ts` que llame a
  `registerBundledSkill(...)` (`src/skills/bundledSkills.ts:53`) y añade su `register...()` a
  `initBundledSkills` (`src/skills/bundled/index.ts:24`). Esa función se invoca desde
  `src/main.tsx:1925`. Referencia pequeña: `src/skills/bundled/loremIpsum.ts`.

### Plugin

- Plugins incorporados al binario: `registerBuiltinPlugin` (`src/plugins/builtinPlugins.ts:~30`);
  aparecen en `/plugin` y pueden activarse o desactivarse. `src/plugins/bundled/index.ts` es el sitio
  donde se registran.
- Plugins externos: `plugin.json` validado por `src/utils/plugins/schemas.ts` (manifiesto, comandos,
  agentes, hooks). Cargadores: `loadPluginCommands.ts`, `loadPluginAgents.ts`, `loadPluginHooks.ts`
  (`loadPluginHooks`, `:91`) en `src/utils/plugins/`.

### Hook

- De configuración, sin compilar: clave `hooks` de `settings.json` (esquema `HooksSchema` en
  `src/schemas/hooks.ts`, referenciado desde `src/utils/settings/types.ts:435`). Los eventos válidos
  están en `HOOK_EVENTS` (`src/entrypoints/sdk/coreTypes.ts:25`: `PreToolUse`, `PostToolUse`,
  `UserPromptSubmit`, `SessionStart`, `Stop`, etc.).
- Un evento nuevo: añádelo a `HOOK_EVENTS`, a los esquemas de entrada de
  `src/entrypoints/sdk/coreSchemas.ts` (por ejemplo, `PreToolUseHookInputSchema`, `:414`) y escribe su
  ejecutor en `src/utils/hooks.ts` imitando `executePreToolHooks` (`hooks.ts:3394`).
- Un hook que bloquea: el mensaje lo arma `getPreToolHookBlockingMessage` (`hooks.ts:1882`).

## 5. Feature flags de compilación

- `feature('NOMBRE')` viene de `import { feature } from 'bun:bundle'` (por ejemplo,
  `src/commands.ts:59`, `src/tools.ts:104`). Es una constante resuelta al compilar: el bundler elimina
  las ramas muertas.
- Lista activa por defecto: solo `VOICE_MODE` (`scripts/build.ts:82`, `const defaultFeatures`).
- Conjunto experimental: `fullExperimentalFeatures` (`scripts/build.ts:11-47`), activado con
  `bun run build:dev:full` o `--feature-set=dev-full`. Flags sueltos: `--feature=NOMBRE`
  (`scripts/build.ts` convierte cada uno en `--feature=` de `bun build`, `:182`).
- Variantes: `bun run build` -> `./cli`; `build:dev` -> `./cli-dev`; `compile` -> `./dist/cli`
  (`package.json:16-19`).
- `FEATURES.md` audita los flags: 88 referenciados, 54 empaquetan y 34 fallan (a fecha de su
  auditoría, 2026-03-31). Antes de depender de uno, mira si bundlea y si necesita OAuth, GrowthBook o
  paquetes `@ant/*` externos (`externals`, `scripts/build.ts:124`).
- Para añadir un flag propio: úsalo con `feature('MI_FLAG')`, añádelo a `fullExperimentalFeatures` o
  compílalo con `--feature=MI_FLAG`, y documéntalo en `FEATURES.md`.

## 6. Ciclo de trabajo

```bash
export PATH="$HOME/.local/bun-npm/node_modules/.bin:$PATH"
# 1. editar
# 2. compilar (unos 15 s; escribe ./cli)
bun run build
# 3. probar a mano con un backend (esta llamada SÍ usa un modelo, hazla solo cuando toque)
fnharness --account llamacpp -p "di hola"
fnharness --account ollama --model qwen3:8b
# 4. tests (no llaman a ningún modelo)
bun test src/services/api/openai-compat
bun test <ruta>
```

Notas:

- `mm` traduce `--account/--model/--small-model/--base-url/--api-key` a variables
  `CLAUDE_MULTIMODEL_*` (`mm:16-23`) y lanza `./cli` (`mm:14`). Cualquier otro argumento pasa al CLI.
- `bun run dev` (`package.json:20`) ejecuta `src/entrypoints/cli.tsx` sin compilar; útil para iterar,
  pero los flags de `feature()` no los fija el script de build ahí, así que el comportamiento puede
  diferir del binario compilado. Valida siempre con `bun run build` antes de dar algo por bueno.
- Para probar sin red ni modelo: tests con backend falso (sección 3) y `./cli --help`.
- No hay script `test` en `package.json`: se invoca `bun test` directamente.

## 7. Trampas conocidas

1. **`isCodexSubscriber` declarada dos veces** en `src/utils/auth.ts`: `:1629` (comprueba
   `getAPIProvider() === 'openai'` o tokens OAuth con scope `codex`) y `:1649` (solo
   `getCodexOAuthTokens()?.accessToken`). En ESM estricto sería un error de sintaxis; Bun lo
   empaqueta sin quejarse (el build pasa), así que el fallo no se ve. Si tocas la lógica de Codex,
   elimina una de las dos de forma deliberada y mira quién la usa: `src/services/api/client.ts:11,319`.
   No añadas una tercera ni edites solo una creyendo que es la única.
2. **`feature()` solo funciona en el bundle y con argumento literal.** Debe usarse directamente como
   condición (`if`, ternario, `&&`/`||`) con una cadena literal; no lo guardes en una variable, no lo
   pases como función ni calcules el nombre. Las ramas muertas se eliminan, por eso las dependencias
   opcionales se cargan con `require()` dentro de la rama (`src/commands.ts:63-91`,
   `src/tools.ts:20-60`) y no con `import` estático. Un `import` estático de un módulo de un flag
   apagado entra igualmente en el bundle y puede romper el arranque.
3. **Flags que compilan pero no arrancan**: `CHICAGO_MCP` necesita el paquete externo
   `@ant/computer-use-mcp` (`FEATURES.md`, sección Build Variants). Compilar bien no implica funcionar.
4. **`applyMultimodelEnv()` debe ser lo primero** en `src/entrypoints/cli.tsx:6`. Si otro import con
   efectos secundarios lee `ANTHROPIC_*` antes, se salta el perfil.
5. **La rama multimodelo de `client.ts` precede a la de Codex** (`client.ts:309` frente a `:319`).
   Reordenarlas cambia qué backend gana.
6. **Memoización**: `COMMANDS` y `loadAllCommands` están memoizadas (`src/commands.ts:257,449`). Un
   comando que depende de config o de auth debe resolverse en `isEnabled`/`availability`, que se
   evalúan en cada llamada, no en el cuerpo de `COMMANDS`.
7. **`fnharness --list` depende de la indentación** de `profiles.ts` (`mm:25`).
8. **Estado del árbol git**: `README.md` aparece borrado y `src/services/api/openai-compat/` y `mm`
   sin versionar en el momento de escribir esto; `CLAUDE.md` aún remite al README. No restaures ni
   borres nada por reflejo: comprueba `git status` antes de un commit.
9. **Dos mundos de modelo**: con un perfil activo, cualquier nombre `claude*` se reasigna al modelo del
   perfil (`resolveModel`, `translate.ts:164`). No lo uses para decidir lógica por nombre de modelo.
10. **`bun:bundle` y los tests**: los tests actuales no importan módulos con `feature()`. Si el tuyo
    lo hace, puede fallar al resolver `bun:bundle` fuera del build; prefiere extraer la lógica pura a
    un archivo sin `feature()` (como hace `profiles.ts` con `resolveProfile`, que es pura y recibe `env`).

## 8. Checklist

- [ ] Busqué un patrón vecino (`GlobTool`, `clear/index.ts`, un preset existente) y lo imité.
- [ ] Registré la pieza en su lista (`COMMANDS`, `getAllBaseTools`, `PROVIDER_PRESETS`,
      `initBundledSkills`).
- [ ] Las dependencias de un flag se cargan con `require()` dentro de `feature(...)`, con literal.
- [ ] No toqué ni dupliqué `isCodexSubscriber`; `applyMultimodelEnv()` sigue primero.
- [ ] Añadí o extendí un test con backend falso; `bun test <ruta>` pasa.
- [ ] `bun run build` termina con `Built ./cli`.
- [ ] Probé a mano con `fnharness --account ... -p "..."` solo si hace falta un modelo real.
- [ ] Si añadí un flag, lo documenté en `FEATURES.md`.
- [ ] Revisé `git status` y `git diff` antes de commitear.
