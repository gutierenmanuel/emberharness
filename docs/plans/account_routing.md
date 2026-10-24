# Enrutado por cuenta (`cuenta:modelo`) y /model unificado

Rama `quick/account-routing`, 24/10/2026. Objetivo: que una petición concreta (sobre todo la de un
subagente) vaya a otra cuenta sin mover la sesión, y que `/model` muestre los modelos de todas las
cuentas conectadas.

## Formato

`cuenta:modelo`, el mismo de la cadena de fallback (`src/services/api/fallbackChain.ts`). El prefijo
cuenta como cuenta solo si es `claude`, un preset integrado o una cuenta guardada en
`accounts.json`; por eso `qwen3:8b` sigue siendo un id de modelo y `ollama:qwen3:8b` es la cuenta
`ollama` con el modelo `qwen3:8b`. Un modelo vacío (`qwen36:`) usa el modelo propio de la cuenta.
En `claude:` se resuelven los alias (`haiku`, `sonnet`, `opus`, `best`, `opusplan`, `[1m]`) contra
las variables de modelo **originales**, las que había antes de que una cuenta multimodelo las
reescribiera.

Ejemplos: `claude:haiku`, `claude:claude-opus-4-6`, `qwen36:qwen36-35b-heretic-q4km`,
`openrouter:deepseek/deepseek-chat`.

## Mecanismo

`src/services/api/accountRouting.ts` (puro + estado mínimo) y un ámbito por petición en
`src/services/api/openai-compat/profiles.ts`:

- `routeForModel(model)` → `{ accountId, profile, model, current }` o `null` sin prefijo.
  `profile` es `null` para `claude` y, para una cuenta OpenAI-compatible, su perfil con el modelo
  fijado. `current` indica que la cuenta ya es la que está en vigor (entonces solo se quita el prefijo).
  Lanza `MultimodelConfigError` si la cuenta existe pero no puede servir (falta clave, URL mala).
  `accounts.json` se relee solo si cambia su `mtime`.
- `ProfileScope` (`AsyncLocalStorage`): dentro de una petición enrutada,
  `getMultimodelProfile()` e `isMultimodelActive()` responden por la cuenta enrutada. Todo lo que
  toca la petición lo ve: cliente, gating de auth, betas, límites, coste. **No se toca
  `process.env`**, así que la sesión principal y otros subagentes en paralelo no se enteran.
- `scopeGenerator` envuelve el generador de streaming para que cada `next()` corra dentro del ámbito
  (AsyncLocalStorage no sigue a un generador entre llamadas hechas desde fuera). El ámbito tiene
  `live`: al terminar la petición pasa a `false`, de modo que un temporizador o promesa creado dentro
  que dispare más tarde vuelve a la cuenta de la sesión en vez de arrastrar el ámbito.

Puntos de entrada enrutados:

| Punto | Qué hace con `cuenta:modelo` |
|---|---|
| `queryModelWithStreaming` / `queryModelWithoutStreaming` (`claude.ts`) | quita el prefijo y ejecuta toda la petición en el ámbito de la cuenta |
| `getAnthropicClient({ model })` (`client.ts`) | mismo trato para llamadores directos: cliente de esa cuenta |
| `getContextWindowForModel`, `getModelMaxOutputTokens` (`utils/context.ts`) | ventana y salida máxima de esa cuenta (autocompact del subagente) |
| `calculateUSDCost` (`utils/modelCost.ts`) | coste con los precios de esa cuenta |
| `getAgentModel` (`utils/model/agent.ts`) | normaliza a `cuenta:<modelo resuelto>` (`claude:haiku` → `claude:claude-haiku-4-5-…`) |
| `withRetry` | una petición enrutada nunca dispara la cadena de fallback (esa cadena cambia la cuenta de la sesión) |

El cliente no se cachea por cuenta: el código base ya crea un cliente por petición
(`getAnthropicClient` es barato) y así cada cuenta sigue con su auth al día.

## `claude:` desde una sesión multimodelo

`applyMultimodelEnv()` / `setActiveProfile()` cambian, con una cuenta OpenAI-compatible activa:

- `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` →
  el modelo de la cuenta. Por eso los alias de `claude:` se resuelven con `getOriginalModelEnv()`.
- `FNHARNESS_ACCOUNT`, `FNHARNESS_ACCOUNT_LABEL`, `FNHARNESS_MODEL_BACKEND` (para la statusline).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` y `DISABLE_TELEMETRY=1`: se quedan puestas; solo
  apagan tráfico no esencial y telemetría, no la petición al modelo.
- No inyecta ninguna `ANTHROPIC_API_KEY` (el texto antiguo de `COMMANDS.md` sobre un placeholder ya
  no describe el código: la clave de relleno vive solo dentro del cliente del adaptador).

El bloqueo real era `isAnthropicAuthEnabled()`, que devuelve `false` si `isMultimodelActive()`. Dentro
del ámbito `claude` eso es `false`, así que `isClaudeAISubscriber()` vuelve a ser cierto, el cliente
usa el token OAuth (`getClaudeAIOAuthTokens`, con refresco normal), y `getAllModelBetas` añade
`oauth-2025-04-20`. El refresco del token no depende de la cuenta activa.

Al revés (sesión Claude, subagente `qwen36:...`): en el ámbito la cuenta es multimodelo, el cliente
usa el adaptador OpenAI-compatible con el perfil de `qwen36` y el modelo sin prefijo.

Nunca se registra ni imprime una clave: los logs de depuración solo dicen si hay cabecera de
autorización (como antes).

## Agent tool, frontmatter y panel

- `model` del schema pasa de enum a cadena: alias (`sonnet`, `opus`, `haiku`, `inherit`) o
  `cuenta:modelo` de una cuenta lista; otra cosa falla con un mensaje que dice el formato
  (`validateAgentModelParam`, `utils/model/routedModels.ts`).
- La descripción de la herramienta añade «Running an agent on another account» con las cuentas
  conectadas y hasta 6 modelos de cada una, sin llamadas de red a proveedores alojados (catálogo y
  servidores locales). Se calcula al construir el esquema de la sesión, que el código base cachea
  por sesión.
- Frontmatter `model: cuenta:modelo` funciona igual (pasa por `getAgentModel`).
- Precedencia: parámetro de la herramienta > frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL`. Un
  `cuenta:modelo` explícito gana a esa variable, que queda como valor por defecto (antes la variable
  lo pisaba todo).
- El estado de la tarea guarda el modelo (`LocalAgentTaskState.model`) y la fila del panel muestra
  `[cuenta]` tras el tipo si no es la cuenta de la sesión:
  `◯ general-purpose [acctb]  contar en B   7s` (captura real, e2e).

## /model

Sin argumento abre `UnifiedModelPicker` (`src/commands/model/UnifiedModelPicker.tsx`): una cabecera
por cuenta conectada (regla del ✓ de `/account`: lista y, si es local, responde), sus modelos debajo
y un filtro que se escribe directamente (todas las palabras deben aparecer en `cuenta:modelo`, nombre
o descripción; si casan con la cuenta, se muestran todos sus modelos). Captura real (pseudo-terminal,
dos cuentas falsas `accta`/`acctb` y los servidores locales de esta máquina):

```
  Modelo
  15 modelos en 6 cuentas conectadas · elegir uno de otra cuenta cambia la
  sesión a esa cuenta
  Filtro: (escribe para buscar por cuenta o modelo)
    ── Cuenta A (accta) · cuenta activa ──
  ❯ ● model-a ✔                             sin datos del catálogo
      model-a-mini                          sin datos del catálogo
    ── Claude (Anthropic) (claude) ──
      Default                               El modelo recomendado para tu plan
      Sonnet                                Equilibrado, el de diario
      Opus                                  El más capaz para razonamiento
                                            complejo
      Haiku                                 Rápido y barato para tareas
                                            simples
    ── Ollama (ollama) ──
      qwen3:1.7b                            sin datos del catálogo
      ...
  ● en uso · también /model cuenta:modelo · el esfuerzo se ajusta con /effort
```

Con `coder` escrito queda solo `── Cuenta B (acctb) ──` / `coder-b`; Enter cambia la sesión:
`Cuenta activa: Custom OpenAI-compatible (acctb) · modelo coder-b · http://127.0.0.1:…/v1`.

- Modelo de la cuenta de la sesión: mismo camino que `/model <nombre>` (validación, hooks,
  recuerdo por cuenta).
- Modelo de otra cuenta: `switchAccountWithHooks(cuenta, modelo)` de `/account`, así se disparan
  `PreModelSwitch`/`PostModelSwitch` y el modelo se recuerda para esa cuenta; después se fija el
  modelo de la sesión (en `claude`, el alias elegido).
- `/model cuenta:modelo` hace lo mismo por argumento; con el prefijo de la cuenta activa solo cambia
  el modelo.
- En una sesión Claude el grupo `claude` usa las opciones de serie (`getModelOptions`); desde otra
  cuenta, una lista fija Default/Sonnet/Opus/Haiku.
- Pierde respecto al selector antiguo el ajuste de esfuerzo con ←/→ (queda `/effort`). El
  `ModelPicker` original sigue en el árbol para sus otros usos.

## Coste

`calculateUSDCost` con una cuenta OpenAI-compatible en vigor usa los precios del catálogo models.dev
(entrada/salida por Mtok; la caché se cobra como entrada). Un servidor local o un modelo sin precio
cuesta 0. Antes se facturaba como el modelo Claude por defecto, también en sesiones multimodelo
normales; ese cambio afecta a todas ellas, no solo a los subagentes.

## Pruebas

- Unitarias (`bun run test:unit`): `accountRouting.test.ts` (parseo, alias, rutas, ámbito con
  generadores y temporizadores), `routedModels.test.ts` (grupos y filtro de `/model`, párrafo del
  Agent tool, validación), `agentPanelRow.test.ts` (`[cuenta]`), `modelCost.routing.test.ts`.
- e2e (`tests/e2e/accountRouting.e2e.test.ts`): dos servidores falsos como dos cuentas; sesión en A,
  el modelo pide `Agent` con `model: "acctb:model-b"` (y `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` puesto):
  la petición del subagente llega a B con `model-b`, A solo ve `model-a` y recibe la respuesta de B
  como resultado de la herramienta. Segundo caso: `/model` en pseudo-terminal lista las cabeceras,
  filtra y cambia a `acctb:coder-b`, que queda activa y recordada en `accounts.json`.
- Prueba real (24/10/2026): sesión en `qwen36` (`http://localhost:8090/v1`) con una copia de
  `.claude.json` y una copia de solo lectura (0400) de las credenciales en un directorio temporal,
  borrada al acabar; el token tenía más de 1 h de vida, así que no hubo refresco. Qwen lanzó un
  `Agent` con `model: "claude:haiku"`; el subagente respondió `HAIKU_OK claude-haiku-4-5-20251001`
  por `/v1/messages` de Anthropic (OAuth), y el log de depuración muestra autocompact con ventana
  180000 para el subagente y 28672 para la sesión qwen36. Sin claves en el log.

## Límites conocidos

- Un render de Ink programado desde dentro de una petición enrutada podría leer un instante el
  perfil enrutado (p. ej. la cabecera). El ámbito muere al acabar la petición, así que no persiste.
- `claude:` / `claude:default` resuelve a Sonnet por defecto (o a `ANTHROPIC_MODEL` original), no al
  modelo por defecto de cada plan.
- El conteo de tokens por API (`countMessagesTokensWithAPI`) sigue usando el modelo de la sesión;
  el de los subagentes sale del `usage` que devuelve su cuenta (el adaptador estima 4 caracteres por
  token en OpenAI-compatible).
- El párrafo de cuentas de la descripción del Agent tool se fija al construir el esquema de la
  sesión: una cuenta conectada más tarde no aparece hasta una sesión nueva (pero sí se acepta).
- La cadena de fallback no se aplica a peticiones enrutadas.
