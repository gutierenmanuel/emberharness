# Plan: selector de modelos de fnharness alimentado por el catálogo de opencode (models.dev)

Fecha: 24/10/2026. Estado: solo investigación y plan, no se ha tocado código.

## 1. Fuente confirmada

opencode (repo `anomalyco/opencode`, antes `sst/opencode`; el nombre antiguo redirige) obtiene su lista de modelos y proveedores de **models.dev**, y lo declara así en su documentación (opencode.ai/docs/models y /docs/providers: «OpenCode uses the AI SDK and Models.dev to support 75+ LLM providers»; «Standard providers pull these [limit fields] from models.dev automatically»).

Detalle del código (`packages/core/src/models-dev.ts`, rama `dev`):

- URL por defecto: `https://models.opencode.ai/api.json` (`defaultSource = "https://models.opencode.ai"`, petición a `${source}/api.json`). Es un espejo de models.dev: descargué los dos y los 5.903.187 bytes son **idénticos** (`cmp`). Basta con `https://models.dev/api.json`.
- TTL de 5 minutos en memoria, con refresco forzable (`refresh(force)`), caché en disco con digest del cuerpo (para no republicar si no cambió) y **snapshot embebido** como fallback offline: `packages/core/src/models-dev/snapshot.txt`, regenerado con `bun run script/update-models-snapshot.ts`.
- `normalize()` convierte cada proveedor en `{id, name, env[], npm, api→settings.baseURL}` y cada modelo en un `Model.Info` con coste, límites, modalidades y variantes de razonamiento (`reasoning_options`).
- La ruta antigua `packages/opencode/src/provider/models.ts` ya no existe (404); el código vive ahora en `packages/core`.

## 2. Catálogo descargado

Ficheros en `/tmp/claude-1000/-home-user-fn-registry/7764cf53-291c-4bd9-bd22-43ad156120b7/scratchpad/models_dev/`:
`api.json` (models.dev) y `api_opencode.json` (espejo, idéntico).

Cifras (24/10/2026): **230 proveedores, 8.881 modelos**. Por tipo de modelo: chat 8.436, image 180, embedding 82, video 69, speech 43, transcription 38, reranking 17, realtime 16. Por estado: 903 `deprecated`, 72 `beta`, 1 `alpha`. 7.796 tienen `tool_call: true`; **5.724 son chat + tool_call + no deprecated + proveedor OpenAI-compat** (los que fnharness podría usar hoy). Todos los modelos traen `limit`; todos los proveedores traen `env`.

### Esquema

El JSON es un objeto `{ "<provider_id>": Provider }`.

Provider:

| Campo | Significado |
|---|---|
| `id`, `name`, `doc` | identificador, nombre visible, URL de documentación |
| `env` | lista de variables de entorno de la clave (p. ej. `["OPENAI_API_KEY"]`; Google: 3 alias; Bedrock: 4 variables AWS) |
| `npm` | paquete AI SDK que lo implementa; **es el discriminador de protocolo** |
| `api` | baseURL; **solo presente** si el proveedor es OpenAI-compat genérico o tiene URL fija; ausente en openai, groq, mistral, togetherai, cerebras, deepinfra, xai, cohere, perplexity, google, azure... (su SDK la trae dentro) |
| `models` | `{ "<model_id>": Model }` |

Model:

| Campo | Significado |
|---|---|
| `id`, `name`, `description`, `family` | |
| `type` | ausente = chat; si no `image/video/embedding/reranking/speech/transcription/realtime` |
| `status` | ausente / `deprecated` / `beta` / `alpha` |
| `limit` | `{context, output, input?}` en tokens (siempre presente) |
| `cost` | USD por millón: `input`, `output`, `cache_read`, `cache_write`, `input_audio`..., y `tiers` por tamaño de contexto |
| `tool_call` | bool: soporta herramientas (imprescindible para el harness) |
| `reasoning` | bool; `reasoning_options`: lista de `{type:"effort", values[]}`, `{type:"toggle"}`, `{type:"budget_tokens"}` |
| `interleaved` | `true` o `{field:"reasoning_content"}`: dónde llega el razonamiento en el stream (1.209 modelos con `field`, 102 con `true`) |
| `attachment` | bool: acepta adjuntos |
| `modalities` | `{input:[text,image,pdf,video,audio], output:[...]}` |
| `structured_output`, `temperature`, `open_weights`, `knowledge`, `release_date`, `last_updated`, `experimental` | |
| `provider` | override por modelo de `{npm, api, shape: "responses"\|"completions"}` (68 casos; algunos apuntan a endpoints no-chat como rerank o flux) |
| `canonical_model_id` | id canónico entre proveedores (útil para agrupar el mismo modelo en varios hosts) |

Ejemplo real: `deepseek/deepseek-v4-flash` → `limit {context: 1048576, output: 393216}`, `interleaved {field: reasoning_content}`, `reasoning_options [toggle, effort low/high/max]`.

## 3. Mapeo OpenAI-compatible vs otro SDK

Discriminador: `npm`.

| Grupo | Proveedores | Modelos | Notas |
|---|---|---|---|
| A. `@ai-sdk/openai-compatible` con `api` | **191** | 6.478 | Uso directo con el adaptador actual (baseUrl = `api`, clave = `env[0]`). Incluye deepseek, moonshotai, zai, nvidia, fireworks-ai, github-copilot, opencode, ollama-cloud, lmstudio, siliconflow, alibaba... |
| B. SDK propio pero con endpoint OpenAI-compat conocido | **16** | 767 | openai, groq, mistral, togetherai, cerebras, deepinfra, xai, cohere, perplexity, google (`/v1beta/openai`), openrouter, neosmith, infer, perplexity-agent, vivgrid, meta. Falta `api` en el catálogo para 10 de ellos: hace falta un **mapa complementario embebido** de baseUrl (openai `https://api.openai.com/v1`, groq `https://api.groq.com/openai/v1`, mistral `https://api.mistral.ai/v1`, togetherai `https://api.together.xyz/v1`, cerebras `https://api.cerebras.ai/v1`, deepinfra `https://api.deepinfra.com/v1/openai`, xai `https://api.x.ai/v1`, cohere `https://api.cohere.ai/compatibility/v1`, perplexity `https://api.perplexity.ai`, google ya está en el preset) |
| **Total usable ya (A+B)** | **207** | **7.245** | 5.724 son chat con tool_call y no deprecated |
| C. Protocolo Anthropic (`@ai-sdk/anthropic`) | 8 | 101 | anthropic, minimax (+cn, +coding-plan x2), subconscious, freemodel, thinkingmachines. fnharness es fork de Claude Code: podrían ir **sin traducción** apuntando `ANTHROPIC_BASE_URL`, pero es otra ruta, fuera de este plan |
| D. SDK/credenciales propias | 15 | 1.535 | amazon-bedrock (199), google-vertex (+anthropic), azure y azure-cognitive-services (recurso/deployment), vercel, cloudflare-ai-gateway, gitlab, sap-ai-core, watsonx, venice, aihubmix, qvac, salad-cloud. Excluir del primer corte; algunos (vercel, venice, aihubmix, cloudflare) quizá exponen endpoint OpenAI pero no figura en el catálogo |

Cruce con los presets actuales de fnharness (`PROVIDER_PRESETS`):

| Preset | Equivalente en catálogo | Observación |
|---|---|---|
| openai | `openai` (51 modelos) | catálogo sin `api`; hay que seguir con el mapa propio |
| openrouter | `openrouter` (391) | `api` coincide |
| groq | `groq` (14) | |
| deepseek | `deepseek` (4) | catálogo dice `https://api.deepseek.com` (sin `/v1`; ambas valen) |
| gemini | `google` (38) | id distinto (`gemini` vs `google`); 3 variables env |
| mistral | `mistral` (34) | |
| together | `togetherai` (32) | id distinto |
| lmstudio | `lmstudio` (3) | catálogo solo trae 3 modelos de muestra; los reales vienen de `/v1/models` |
| ollama | `ollama-cloud` (23) es el servicio cloud, **no** el local | el local no está en el catálogo |
| llamacpp, qwen36, custom | **no están** | locales/propios: lista solo por `GET /v1/models` |

Es decir, los 9 presets hospedados ya están en el catálogo; los locales no. Los 182+ proveedores restantes del grupo A son nuevos.

## 4. Estado actual de fnharness (leído)

- `src/services/api/openai-compat/profiles.ts`: `PROVIDER_PRESETS` (baseUrl, apiKeyEnv, defaultModel, maxTokensParam, contextWindow?, maxOutputTokens?). `resolveProfile(env)` es pura. `setActiveProfile` pone `ANTHROPIC_MODEL`, `..._SMALL_FAST_MODEL`, `..._DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` con el modelo del perfil. `contextWindow`/`maxOutputTokens` son **del perfil entero**, no por modelo.
- `accounts.ts`: `StoredAccount {provider,label,baseUrl,apiKey,model,smallModel}`, almacén en `$CLAUDE_CONFIG_DIR/accounts.json`. `bin/fnharness` fija `CLAUDE_CONFIG_DIR=$HOME/.fnharness`, así que el fichero real es `~/.fnharness/accounts.json` (modo 0600). Ya existe `probeBackend()` (`GET {baseUrl}/models`, 800 ms) e `isLocalUrl()`.
- `src/commands/account/{account.tsx,actions.ts}`: `/account`, `list`, `<id> [modelo]`, `key`, `add <id> <baseUrl> [modelo]` (siempre `provider:'custom'`), `remove`.
- `src/commands/model/model.tsx` + `src/components/ModelPicker.tsx` + `src/utils/model/modelOptions.ts` (`getModelOptions` → `getModelOptionsBase`): lista **solo modelos Claude** (alias sonnet/opus/haiku, 1M, etc.) o Codex; no conoce el backend multimodel. `/model <id>` pasa por `validateModel.ts`, que ya devuelve `valid` si `isMultimodelActive()`, así que escribir un id a mano funciona, pero el selector no lo ofrece. Además `/model` cambia solo `mainLoopModel` del AppState: no persiste en `accounts.json` ni actualiza `profile.model`.
- `src/utils/context.ts` (líneas ~71 y ~163): lee `getMultimodelProfile()?.contextWindow` y `?.maxOutputTokens` para auto-compact y límite de salida; recibe `model` pero lo ignora en la rama multimodel.
- `src/services/api/client.ts` (l. 305) crea el cliente con el adaptador; `adapter.ts` usa `profile.model`, `maxTokensParam`; `stream.ts` ya mapea `delta.reasoning_content` / `delta.reasoning` a bloques `thinking`.
- `src/entrypoints/cli.tsx` llama `applyMultimodelEnv()` antes que nada (sin async: la carga del catálogo en arranque debe ser **síncrona y solo de disco**).

## 5. Diseño propuesto

### 5.1 Módulo de catálogo (nuevo): `src/services/api/openai-compat/catalog.ts`

Separar puro de efectos:

- Puras: `parseCatalog(json)`, `compatKind(provider)` → `'openai' | 'anthropic' | 'other'` según `npm`, `resolveBaseUrl(providerId, provider)` (campo `api` o mapa `KNOWN_BASE_URLS`), `chatModels(provider, {includeDeprecated})` (filtra `type` ausente o `chat`, `tool_call`, `status !== deprecated`), `modelLimits(model)` → `{contextWindow: limit.context, maxOutputTokens: limit.output}`, `presetAlias` (`gemini→google`, `together→togetherai`, `ollama→ollama-cloud`).
- Efectos (bordes): `loadCatalogSync()` y `refreshCatalog()`.

Caché:

1. `~/.fnharness/models.json` = copia cruda de `https://models.dev/api.json` + sidecar `~/.fnharness/models.meta.json` `{fetchedAt, etag}` (o campo envuelto). TTL **24 h** (opencode usa 5 min porque tiene un daemon; para un CLI es excesivo). Revalidar con `If-None-Match`; escribir a `.tmp` + `rename` (atomicidad con varias sesiones).
2. Fallback offline embebido: `src/services/api/openai-compat/catalog.snapshot.json`, **reducido** (solo proveedores grupo A+B, solo chat+tool_call no deprecated, campos `id,name,limit,cost,reasoning,interleaved,modalities,tool_call,status`). Estimado ~1,5 MB frente a los 5,9 MB crudos; si molesta, quedarse con los ~25 proveedores más usados. Se regenera con `scripts/update-models-snapshot.ts` (nuevo, calca el de opencode) y se ejecuta en el build.
3. Orden de lectura sincrónica en arranque: caché de disco → snapshot embebido. El refresco de red se lanza **en segundo plano** tras el arranque (nunca bloquea; si falla, silencio y se mantiene la caché).
4. Variables: `FNHARNESS_MODELS_URL` (permite el espejo `models.opencode.ai` o uno propio) y `FNHARNESS_DISABLE_MODELS_FETCH=1` (como `OPENCODE_DISABLE_MODELS_FETCH`). Comando `/models refresh` o `/account refresh`.

### 5.2 Presets toman datos del catálogo (`profiles.ts`)

- Mantener `PROVIDER_PRESETS` como fuente para **locales** y como fallback (no se rompe nada si no hay catálogo).
- `MultimodelProfile` gana `catalogProvider?: string`. En `resolveProfile`, tras elegir `model`, buscar `limit` en el catálogo y rellenar `contextWindow`/`maxOutputTokens` **si el preset/cuenta no los fija explícitamente** (el override manual, p. ej. qwen36 a 32768, gana siempre: es la ventana real configurada en llama-server, no la del modelo).
- Como el modelo puede cambiar con `/model` sin recargar el perfil, mover la consulta a una función `getModelLimits(model)` y que `utils/context.ts` la use en las dos ramas multimodel (hoy ignoran `model`). Esto es lo que da el beneficio real: auto-compact correcto por modelo.
- `maxTokensParam`: el catálogo no lo indica. Regla: `openai` y modelos o-series/gpt-5 usan `max_completion_tokens`; el resto `max_tokens`. Mantenerlo por proveedor en el mapa complementario `KNOWN_PROVIDER_QUIRKS`.
- Razonamiento: usar `interleaved.field` (`reasoning_content` vs `reasoning`) para saber dónde leerlo; `stream.ts` ya acepta ambos, así que en el primer corte basta con ignorarlo. `reasoning_options` queda para una fase posterior (mapear esfuerzo a `reasoning_effort`).

### 5.3 `/model` lista los modelos de la cuenta activa

En `modelOptions.ts`, al inicio de `getModelOptions`: si `isMultimodelActive()`, devolver `getMultimodelModelOptions()` en vez de la lista Claude (también hay que saltar los hooks de suscriptor/1M del picker). Origen de las opciones, fusionadas y deduplicadas por id:

1. Catálogo del proveedor activo (`catalogProvider`): `value=id`, `label=name`, `description` = `ctx 128k · out 16k · $in/$out · tools · razonamiento · imagen`. Orden: el modelo actual primero, luego por `release_date` descendente.
2. `GET {baseUrl}/models` del servidor (para ollama, llamacpp, qwen36, lmstudio y custom; también como verificación en los hospedados). Reutilizar `probeBackend` generalizándolo a `fetchServerModels(baseUrl, apiKey, timeout)` que devuelva ids. Se pide al abrir el selector con timeout corto (800 ms locales, 3 s remotos) y el selector se muestra ya con el catálogo, completando cuando llega la respuesta (o dos pasos: render inmediato + `setState`). En servidores locales, los ids del servidor mandan; si el id coincide con un modelo del catálogo se enriquece con sus límites.
3. Alias de `smallModel`: opción extra «Modelo pequeño: …» o, más simple en el primer corte, `smallModel` sigue siendo el de la cuenta.
4. Siempre una entrada «Otro (escribir id)» (el picker ya soporta un valor personalizado) y se acepta `/model <id>` libre como hoy.

Al seleccionar, además de `mainLoopModel`, `ModelPickerWrapper.handleSelect` debe llamar a una acción `setAccountModel(id, model)` para persistir en `accounts.json` y actualizar `setActiveProfile` (ahora no lo hace; hay que corregirlo o el modelo vuelve al `defaultModel` al reabrir). Para no tocar el wrapper generado por el compilador de React (`_c`), lo más limpio es crear un hook `useMultimodelSelect` o interceptar en `model.tsx` `setModel()`.

### 5.4 `/account` da de alta cualquier proveedor del catálogo

- `listAccounts` añade, tras las cuentas guardadas y los presets, el **catálogo bajo demanda** (no 207 entradas en el selector principal: agrupar en la pestaña/sección «Catálogo (207)» con búsqueda por texto; `Select` no filtra, por lo que conviene `/account catalog [texto]` como lista textual y un segundo `Select` paginado).
- Nuevo subcomando `/account add <provider_id> [id] [modelo]`: si `provider_id` está en el catálogo y es de grupo A/B, crea `StoredAccount {provider: 'catalog:<provider_id>', label: name}` sin pedir URL (hoy `add` exige `<baseUrl>` y fuerza `custom`). Mantener la forma antigua `add <id> <baseUrl>` si el segundo argumento empieza por `http`.
- `resolveProfile` resuelve `provider` con prefijo `catalog:` o directamente un id de catálogo no presente en `PROVIDER_PRESETS`: baseUrl desde `resolveBaseUrl`, `apiKeyEnv` = `env[0]` (y leer cualquiera de `env[]` por orden), `defaultModel` = el chat con `tool_call` más reciente, o el primero de `/v1/models`.
- Proveedores de grupo C/D: aparecen en `/account catalog` marcados «requiere otro protocolo (anthropic|bedrock|vertex|azure)» y no se pueden activar (mensaje claro). Futuro: C se podría enrutar al cliente Anthropic nativo con `ANTHROPIC_BASE_URL`.
- Almacenar la clave sigue como hoy (`/account key`), con fallback a variables de entorno del catálogo (ya existe `apiKeyEnv`).

## 6. Ficheros exactos a tocar

Nuevos:

- `src/services/api/openai-compat/catalog.ts` (+ `catalog.test.ts`)
- `src/services/api/openai-compat/catalog.snapshot.json` (generado)
- `scripts/update-models-snapshot.ts` (descarga, reduce y escribe el snapshot) y enganche en `scripts/build.ts`
- `src/services/api/openai-compat/serverModels.ts` o función en `accounts.ts` (`fetchServerModels`)

Modificados:

- `src/services/api/openai-compat/profiles.ts`: `MultimodelProfile.catalogProvider`, resolución `catalog:` y de ids no-preset, límites desde catálogo con prioridad del override, `KNOWN_PROVIDER_QUIRKS`.
- `src/services/api/openai-compat/accounts.ts`: `listAccounts` incluye origen catálogo, `profileForAccount` acepta ids de catálogo (hoy lanza «Unknown account» si no está en presets ni en el store), generalizar `probeBackend`.
- `src/commands/account/account.tsx` y `actions.ts`: `catalog`, `add <provider>`, `refresh`, ayuda (`HELP`); `setModel` persistente (`setAccountModel`).
- `src/commands/model/model.tsx`: persistir la elección en la cuenta; mensaje sin «Billed as extra usage» etc. en modo multimodel.
- `src/utils/model/modelOptions.ts` (`getModelOptions`/`getModelOptionsBase`): rama multimodel.
- `src/components/ModelPicker.tsx`: descripción rica, carga asíncrona de `/v1/models`, ocultar el selector de esfuerzo/1M de Claude si multimodel (revisar `effort.ts`).
- `src/utils/context.ts` (l. ~71 y ~163): límites por modelo vía `getModelLimits(model)`.
- `src/entrypoints/cli.tsx`: disparar el refresco en segundo plano tras `applyMultimodelEnv()`.
- Tests: `accounts.test.ts`, `openai-compat.test.ts` (mocks de catálogo con un fixture mínimo).
- Documentación: `docs/COMMANDS.md`, `FEATURES.md`, `changes.md`.

## 7. Plan por pasos (cada uno entregable y testeable)

1. **Catálogo**: `catalog.ts` con parseo y funciones puras + fixture de test + script de snapshot. Verificable con `bun test` sin red.
2. **Caché y refresco**: lectura síncrona (disco → snapshot), refresco en segundo plano con TTL 24 h, ETag, escritura atómica, variables de entorno. Prueba: sin red arranca con snapshot; con red crea `~/.fnharness/models.json`.
3. **Límites por modelo**: `getModelLimits` y cambio en `utils/context.ts` y `resolveProfile`. Es el cambio de mayor valor y menor riesgo: mejora auto-compact en todos los presets hospedados.
4. **`/model` multimodel**: opciones de catálogo + `GET /v1/models` + persistencia en la cuenta. Probar con qwen36/llamacpp (servidor) y deepseek/openai (catálogo).
5. **`/account catalog` y `add <provider>`**: alta de cualquier proveedor A/B; resolución de baseUrl/clave; mensajes para C/D.
6. **Pulido**: orden por fecha, búsqueda, etiquetas de coste, `reasoning_options` → `reasoning_effort`, ruta Anthropic-wire (grupo C) opcional.

## 8. Riesgos

- **Tamaño**: 5,9 MB crudos; cargar y parsear en cada arranque cuesta decenas de ms. Mitigar: snapshot reducido, `JSON.parse` perezoso (solo al abrir `/model`, `/account` o al resolver límites) y memoizar.
- **Arranque síncrono**: `applyMultimodelEnv()` es sync y corre antes de todo; el catálogo ahí solo puede ser lectura de disco, jamás red.
- **Falta `api` en el grupo B**: el mapa complementario puede quedar obsoleto; verificar con un test que cada proveedor del grupo B resuelve baseUrl y avisar en el script de snapshot si aparece un `npm` nuevo sin mapeo.
- **Dialectos**: «OpenAI-compatible» no es uniforme (campos de razonamiento, `max_completion_tokens`, `tool_choice`, `stream_options`, `shape: responses` de modelos concretos que solo hablan la API Responses). Los modelos con `provider.shape === 'responses'` o `provider.api` apuntando a endpoints no-chat (rerank, flux) deben **filtrarse** del selector.
- **Ventana real vs catálogo**: en servidores locales la ventana la fija el arranque del servidor (qwen36: 32k) y no el modelo (el catálogo diría 256k). El override explícito del preset/cuenta debe prevalecer; para llama.cpp se podría leer `/props` (`n_ctx`) como mejora.
- **Calidad del catálogo**: 903 deprecated y datos comunitarios (ids o límites erróneos). Ocultar deprecated por defecto, permitir `/model <id>` libre siempre, y no bloquear si el id no está.
- **Ids no estables**: el mismo modelo con distinto id por proveedor; el `canonical_model_id` ayuda a agrupar pero no sirve como valor a enviar.
- **Persistencia de modelo**: hoy `/model` no se guarda por cuenta; al corregirlo hay que cuidar que `smallModel` (tareas de fondo) no se quede apuntando a un modelo de otro proveedor al cambiar de cuenta.
- **Claves y privacidad**: la petición a models.dev no lleva credenciales; sí se envía IP/UA. Respetar `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (que `setActiveProfile` ya activa) saltando el refresco si está a `1` y dejando solo `FNHARNESS_MODELS_URL`/`/models refresh` explícito. Decisión a confirmar: con ese flag siempre puesto en modo multimodel, el refresco automático nunca se ejecutaría; propuesta: ignorar el flag solo para este fetch y gobernarlo con `FNHARNESS_DISABLE_MODELS_FETCH`.
- **Compilador de React**: `model.tsx` y `ModelPicker.tsx` son salida de `react/compiler-runtime` (`_c`); editarlos a mano es frágil. Preferir hooks/módulos nuevos y cambios mínimos en esos ficheros.
- **Fork de Claude Code**: la lógica de suscriptor, Fast mode, 1M, esfuerzo y facturación en `/model` no aplica a terceros y puede mostrar mensajes erróneos si no se filtra en modo multimodel.
- **Dependencia de upstream**: models.dev es de la comunidad (SST/Anomaly); si desapareciera, queda el snapshot embebido y la caché de disco, por eso el fallback no es opcional.
