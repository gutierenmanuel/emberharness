# Perfil de contexto (`/scope`, Ctrl+Tab)

Estado: implementado (24/10/2026, rama `quick/context-profile`).

## 1. Para qué

Un modelo local pequeño (qwen36 con 32k de ventana) no puede pagar en cada petición unos 17k
tokens de prompt de sistema, definiciones de tools y lista de skills. El perfil de contexto decide qué
entra al modelo en cada petición, con tres ejes independientes:

| Eje | Valores | Qué filtra |
|---|---|---|
| `mcp` | `full` · `folder` · `user` · `none` | Tools e instrucciones de servidores MCP según el `scope` de su config: `folder` = `project` y `local`; `user` = `user`; los demás scopes (`dynamic`, `claudeai`, `managed`, `enterprise`, plugins) solo con `full`. |
| `skill` | `full` · `folder` · `user` · `none` | Skills y comandos que ve el modelo (lista `skill_listing` y validación de `SkillTool`) según su `source`: `folder` = `projectSettings`/`localSettings`; `user` = `userSettings`; `bundled`, `plugin`, `mcp` y `policySettings` solo con `full`. Con `none` no se envía `SkillTool`. Los slash commands siguen disponibles para la persona. |
| `tools` | `full` · `simple` · `none` | Tools integradas: `simple` = Bash, Read, Write, Edit, Glob, Grep y Agent, con prompt de sistema y descripciones compactos (sección 4); `none` = ninguna (solo chat). |

Presets, en el orden en que los rota Ctrl+Tab (Ctrl+Shift+Tab va al revés):

| Preset | mcp | skill | tools |
|---|---|---|---|
| Full | full | full | full |
| Folder | folder | folder | full |
| User | user | user | full |
| Simple | none | none | simple |
| Nothing | none | none | none |

Una combinación suelta (por ejemplo `mcp:user skill:none tools:simple`) salta a Full con Ctrl+Tab y a
Nothing con Ctrl+Shift+Tab.

## 2. Uso

- `/scope`: estado y selector de presets, con el coste estimado de cada uno.
- `/scope simple`, `/scope nothing`, ... (alias: `nada`, `chat`, `carpeta`, `usuario`, `todo`).
- `/scope mcp:folder skill:user tools:simple`: ejes sueltos sobre el perfil actual; un preset delante
  sirve de base (`/scope user tools:simple`).
- Ctrl+Tab / Ctrl+Shift+Tab: acciones `chat:cycleContextProfile` y `chat:cycleContextProfileBack`
  (contexto `Chat`), reconfigurables en `keybindings.json`.
- Pie: `⏵ simple mode · ctx: simple ~12k tok · ...`. Para una combinación suelta se muestra
  `ctx: m:user s:none t:simple`. La pista `(shift+tab to cycle)` del modo de permisos se quitó para
  que el pie quepa; los atajos siguen en `?`.
- `FNHARNESS_CONTEXT_PROFILE=<preset o "mcp:x skill:y tools:z">` fuerza el perfil al arrancar sin
  tocar lo guardado (útil en `-p`, scripts y tests).

## 3. Persistencia y valores por defecto

Se recuerda por cuenta:

- Cuentas multimodelo: campo `contextProfile` (`{mcp, skill, tools}`) de la cuenta en
  `accounts.json` (`<CLAUDE_CONFIG_DIR>/accounts.json`).
- Cuenta `claude`: campo `contextProfile` de la config global (`.claude.json`).

Sin perfil guardado: `claude` → Full; cuentas con backend local (`isLocalUrl`: qwen36, llamacpp,
ollama, lmstudio, `custom` en 127.0.0.1...) → Simple; el resto → Full. Al cambiar de cuenta con
`/account` se carga el perfil de esa cuenta.

## 4. Diseño

- Lógica pura en `src/utils/contextProfile.ts` (presets, ciclo, parseo de `/scope`, filtros de tools,
  clientes MCP y skills, default por cuenta, aplanado de bloques de tools). Tests:
  `src/utils/contextProfile.test.ts`.
- Persistencia en `src/utils/contextProfileStore.ts` (`resolveInitialContextProfile`,
  `loadContextProfileForAccount`, `saveContextProfileForAccount`, `applyContextProfile`). Tests:
  `src/utils/contextProfileStore.test.ts`.
- Estado: `AppState.contextProfile` (undefined = Full), inicializado en `getDefaultAppState()` y en el
  `initialState` de `main.tsx`.
- Aplicación por turno: `REPL.tsx` (`getToolUseContext`) lee el perfil una sola vez al empezar el
  turno; `computeTools` (también usado como `refreshTools` a mitad de turno) y `mcpClients` usan esa
  copia, que viaja en `toolUseContext.options.contextProfile`. Un cambio a mitad de turno se aplica en
  el siguiente. En `-p`, `buildAllTools` de `print.ts` filtra igual.
- El `tools` de render del REPL (`useMergedTools`) NO se filtra: los mensajes antiguos con tools que ya
  no están en el perfil se siguen pintando. Si el modelo llama a una tool que ya no está, recibe el
  error normal de tool inexistente (el mismo camino que un MCP desconectado).
- Sin ninguna tool (`tools:none`) la API rechaza bloques `tool_use`/`tool_result` del historial;
  `claude.ts` los convierte a texto (`flattenToolBlocks`) antes de enviar.
- Con `tools:none` `getSystemPrompt` devuelve un prompt corto de chat (~0,5k tokens) en vez del de
  agente (~6k).
- Subagentes (`AgentTool`, `resumeAgent`): `Agent` está en Simple, así que una sesión local puede
  lanzarlos; el subagente recibe siempre las tools integradas completas y hereda los ejes `mcp` y
  `skill` (`filterWorkerToolsByProfile`). Con `tools:none` no hay `Agent`.
- Prompts compactos de Simple (`src/constants/compactPrompts.ts`): cuando el conjunto de tools es el
  de Simple (`isCompactToolSet`: las seis tools de archivos y shell, con o sin `Agent`, y nada más),
  `getSystemPrompt` devuelve un prompt propio de fnharness (identidad, entorno con cwd, git sí/no,
  plataforma, shell y fecha, reglas mínimas de uso de tools, seguridad y estilo) en lugar del de
  Claude Code, y `toolToAPISchema` sustituye el texto de `tool.prompt()` por una descripción de un
  párrafo para cada una de las siete tools. Los `input_schema` no se tocan. Las descripciones
  compactas se cachean con clave `compact:<tool>` para no mezclarse con las completas al cambiar
  de perfil. La lista de tipos de agente va en la descripción de `Agent` (una línea por tipo, 90
  caracteres) salvo que ya viaje como adjunto. `CLAUDE.md` de proyecto y usuario siguen entrando por
  el contexto de usuario, igual que en los demás perfiles. La detección es por el conjunto de tools
  (no por el perfil) porque `getSystemPrompt` no recibe el perfil; un subagente con menos de seis
  tools mantiene los prompts normales.
- Al cambiar de perfil se vacía la caché de secciones del prompt de sistema
  (`clearSystemPromptSections`), que depende del conjunto de tools.
- Estimación (`src/utils/contextProfileEstimate.ts`): prompt de sistema + esquemas de tools que se
  envían de verdad (sin las diferidas tras ToolSearch) + lista de skills, a razón de 4 caracteres por
  token, sin llamar a ninguna API. Se cachea por perfil, modelo, modo y pool de MCP; para calcularla
  se guarda y restaura la caché de secciones del prompt, así que estimar otro perfil no contamina la
  petición real.
- Teclado: el parser ya reconocía Ctrl+Tab en el protocolo de kitty (`CSI 9;5u`, Ctrl+Shift+Tab
  `CSI 9;6u`; fnharness activa el protocolo con `CSI >1u` en terminales que lo soportan) y en xterm
  modifyOtherKeys (`CSI 27;5;9~` / `CSI 27;6;9~`). Se añadió `!e.ctrl` al Tab de `useTypeahead` para
  que Ctrl+Tab no dispare el autocompletado. Tests: `src/keybindings/ctrlTab.test.ts`. Un Tab
  normal (`\t`) en un terminal sin estos protocolos es indistinguible de Ctrl+Tab: ahí la tecla no
  funciona y queda `/scope`.

## 5. Medidas

Servidor OpenAI-compatible falso (`tests/e2e/harness.ts`), sandbox vacío (sin `CLAUDE.md`, sin MCP,
sin skills de usuario ni proyecto; solo las bundled), petición real capturada en `-p "di hola"` con
`FNHARNESS_CONTEXT_PROFILE=<preset>`. Tokens = caracteres / 4. La cuenta qwen36 envía el mismo
payload (lo construye el harness; solo cambia el id de modelo), así que no se midió aparte.

| Preset | Tools enviadas | Sistema | Tools | Mensaje de usuario (skills, contexto) | Total real | Estimación del pie |
|---|---|---|---|---|---|---|
| Full | 14 | 6.457 | 10.386 | 330 | ~17,2k | ~17k |
| Folder | 14 | 6.457 | 10.386 | 145 | ~17,0k | ~17k |
| User | 14 | 6.457 | 10.386 | 145 | ~17,0k | ~17k |
| Simple (antes: 6 tools, prompt completo) | 6 | 6.165 | 5.374 | 88 | ~11,6k | ~12k |
| Simple (ahora: 7 tools con Agent, compacto) | 7 | 359 | 2.520 | 88 | ~3,0k | ~2,8k |
| Nothing | 0 | 486 | 0 | 88 | ~0,6k | ~453 |

Detalle de Simple por tool, en caracteres (descripción antes / ahora; el schema no cambia): Bash
10.122 / 486 (schema 1.428), Read 1.680 / 273 (740), Edit 1.095 / 247 (552), Write 618 / 215 (348),
Glob 371 / 157 (539), Grep 866 / 314 (2.442), Agent 751 con tres tipos de agente (schema 1.002; la
descripción completa de Agent mide ~16,7k caracteres y no se envía en Simple).

En este sandbox Folder y User solo se diferencian de Full en la lista de skills bundled; con
servidores MCP de usuario o de proyecto la diferencia crece con ellos.

Lectura: Simple pasa de ~11,6k a ~3,0k tokens de 32k (con Agent incluida): el prompt de sistema baja
de ~6,2k a ~0,36k y las definiciones de tools de ~5,4k a ~2,5k, de las cuales ~1,6k son input schemas
que se mantienen intactos (el de Grep pesa 2,4k caracteres). 
Prueba real con qwen36 (llama-server, `-p`, tarea «crea hola.txt con Write, léelo con Read y corre
`wc -c hola.txt` con Bash», 6 ejecuciones por variante, temperatura 0,5): el prompt completo antiguo
lo hizo bien 6 de 6; el compacto final, 5 de 6 (4 limpias, 1 con las llamadas desordenadas pero el
fichero creado, 1 que afirmó haber creado el fichero sin llamar a ninguna tool). Aprendido al ajustar
el prompt, midiendo con la petición real repetida contra el modelo: (1) una línea «las rutas deben ser
absolutas» hacía que el modelo comprobara antes de escribir y alucinara resultados (3/12 → 11/12 al
quitarla; los schemas y descripciones ya lo dicen); (2) las reglas de orden y paralelismo de tools
también empeoraban; (3) la sección «Lead with the action, not the reasoning» del prompt original es la
que más ayuda y se conservó; (4) palabras como «overwrite» o «existing file» en seguridad o en la
descripción de Write inducen al modelo a decir que el fichero ya existe. Con un modelo de 35B el
margen de error sigue siendo apreciable: si el modelo afirma algo sin llamar a la tool, hay que
repetir o pasar a Full en una cuenta mayor.

## 6. Pruebas

- Unitarias: `bun run test:unit` (presets, ciclo, parseo, filtros, default por cuenta, aplanado,
  persistencia en `accounts.json`, `FNHARNESS_CONTEXT_PROFILE`, secuencias de Ctrl+Tab).
- e2e (`tests/e2e/scope.e2e.test.ts`): cuenta local → exactamente las 7 tools básicas (con `Agent`); perfil guardado en
  `accounts.json` respetado (Nothing → sin tools); Full frente a Nothing (sin tools y prompt de
  sistema de menos de la mitad); paso a Nothing tras llamadas a Bash con `--continue` (la petición
  no lleva `tool_calls` ni mensajes `tool`, sí el texto `[tool call Bash ...]`); y la TUI en un
  pseudo-terminal recibiendo `CSI 9;5u` → `CSI 27;5;9~` → `CSI 9;6u` (simple → nothing → full →
  nothing, comprobado en `accounts.json` y en el pie).
- e2e de Simple compacto: la petición lleva exactamente las 7 tools, el prompt de sistema es el de
  fnharness (con el cwd), prompt + definiciones de tools suman menos de 4k tokens (caracteres / 4),
  el prompt es menos de una cuarta parte del de Full y los `parameters` de cada tool son idénticos a
  los de Full. Unitarias: `src/constants/compactPrompts.test.ts`.
- A mano en pseudo-terminal: `/scope` (selector con las estimaciones de la tabla) y
  `/scope user tools:simple` (pie `ctx: m:user s:user t:simple ~12k tok`).
