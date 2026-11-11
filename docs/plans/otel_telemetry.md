# Telemetría OpenTelemetry por cuenta y modelo, con dos destinos

Plan ejecutable. Fecha: 11/11/2026. Estado: sin empezar; las decisiones abiertas están en la sección 9.

Objetivo: que fnharness emita la misma telemetría OTel que Claude Code (métricas `claude_code.*` y
eventos `claude_code.*`). Cada métrica y cada evento llevan atribuida la cuenta (`claude`, `qwen36`,
`ollama`…) y el modelo que sirvieron cada petición, también cuando un subagente corre en otra
cuenta. Los datos se envían a dos destinos independientes:

1. **Corporativo**: el que fija la empresa por *remote managed settings* (hoy Datadog EU). Recibe
   solo lo que IT espera medir, con el esquema oficial de Claude Code y sin atributos propios.
2. **Propio**: nuestro destino (local o VPS). Recibe todo, de todas las cuentas, con los atributos
   enriquecidos de fnharness.

## 1. Estado actual (inventario del 11/11/2026)

### 1.1 La configuración corporativa llega, pero no se usa

- `~/.fnharness-work/remote-settings.json` trae en `env`: `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.datadoghq.eu`, `OTEL_EXPORTER_OTLP_HEADERS=dd-api-key=…`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_METRICS_EXPORTER=otlp`,
  `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_INCLUDE_SESSION_ID=false` y
  `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production`. Esas variables están en el entorno
  de cada sesión.
- La telemetría está desactivada en el build OSS:
  - `src/utils/telemetry/instrumentation.ts`: `isTelemetryEnabled()` devuelve `false` y
    `initializeTelemetry()`, `bootstrapTelemetry()` y `flushTelemetry()` están vacíos.
  - `src/utils/telemetry/events.ts`: `logOTelEvent()` no hace nada e `isUserPromptLoggingEnabled()`
    devuelve `false`.
  - `src/entrypoints/init.ts:210`: `initializeTelemetryAfterTrust()` vuelve sin hacer nada. Lo llama
    `main.tsx:2644`.
- **Consecuencia: hoy IT no recibe nada de las sesiones de fnharness**, ni siquiera de las que usan la
  cuenta Claude de empresa. Esta es la razón principal del plan.

### 1.2 Lo que sigue vivo (solo falta conectarlo)

| Pieza | Dónde | Notas |
|---|---|---|
| Contadores | `src/bootstrap/state.ts` (`setMeter`, l. 961) | `claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `cost.usage`, `token.usage`, `code_edit_tool.decision`, `active_time.total`. Tipo `AttributedCounter` |
| Coste y tokens | `src/cost-tracker.ts:291` (`addToTotalSessionCost`) | Atributos `{ model, speed? }`; tokens por `type` (input, output, cacheRead, cacheCreation) |
| LOC | `src/utils/diff.ts:72` | `type: added/removed` |
| Commits y PR | `src/tools/shared/gitOperationTracking.ts` | |
| Decisiones de edición | `services/tools/toolExecution.ts:976`, `hooks/toolPermission/permissionLogging.ts:216` | |
| Tiempo activo | `src/utils/activityManager.ts` | |
| Eventos | `logOTelEvent(...)` | `user_prompt` (2), `api_request`, `api_error`, `tool_result` (2), `tool_decision` (2), `hook_execution_start/complete`, `feedback_survey` |
| Atributos comunes | `src/utils/telemetryAttributes.ts` | `user.id`, `session.id`, `organization.id`, `user.email`, `user.account_uuid`, `terminal.type`; respeta `OTEL_METRICS_INCLUDE_*` |
| Dependencias | `package.json` | SDK completo `@opentelemetry/*` (exportadores OTLP grpc, http y proto, y Prometheus) |
| Diálogo de seguridad | `src/services/remoteManagedSettings/securityCheck.tsx` | `checkManagedSettingsSecurity` muestra un diálogo bloqueante cuando cambian ajustes peligrosos. Hay que comprobar en la fase 0 que las variables `OTEL_*` lo disparan, como en Claude Code |

### 1.3 Interacciones con el enrutado por cuenta (`account_routing.md`)

- `ProfileScope` (AsyncLocalStorage): dentro de una petición enrutada, `getMultimodelProfile()` e
  `isMultimodelActive()` responden por la cuenta enrutada. **Es la fuente de verdad de la cuenta en
  cada petición.** `calculateUSDCost` ya la usa.
- `profiles.ts:374`: una cuenta OpenAI-compatible activa pone `DISABLE_TELEMETRY ||= '1'` y
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ||= '1'`. `utils/privacyLevel.ts` lo traduce a
  `no-telemetry`. Si la telemetría nueva respetara esa variable tal cual, una sesión en `qwen36` que
  lance un subagente `claude:haiku` no reportaría ese consumo de Claude a la empresa. Hay que
  distinguir el `DISABLE_TELEMETRY` que pone el perfil del que pone la persona o IT.
- Variables de sesión: `FNHARNESS_ACCOUNT`, `FNHARNESS_ACCOUNT_LABEL` y `FNHARNESS_MODEL_BACKEND`.
  Sirven para la cuenta de la sesión, no para la de cada petición.
- El modelo llega como `cuenta:modelo` en peticiones enrutadas, y `queryModel*` quita el prefijo. En
  `addToTotalSessionCost` el `model` ya va sin prefijo.

## 2. Arquitectura

```
                    ┌──────────── AttributedCounter (dual) ─────────────┐
call site ─ add() ─▶│ attrs base + attrs de cuenta (resolveTelemetryCtx) │
                    │   ├─ corp?  (filtro de cuenta) ─▶ MeterProvider corp ─▶ OTLP corp (Datadog)
                    │   └─ own?                      ─▶ MeterProvider own  ─▶ OTLP propio
                    └────────────────────────────────────────────────────┘
logOTelEvent ─────▶ mismo reparto con dos LoggerProvider (eventos claude_code.<nombre>)
```

### 2.1 Contexto de telemetría por petición (`src/utils/telemetry/context.ts`, nuevo, puro)

`resolveTelemetryCtx(model?)` devuelve:

| Campo | Fuente | Ejemplo |
|---|---|---|
| `account` | `ProfileScope` vigente → id de cuenta; si no hay ámbito, `FNHARNESS_ACCOUNT` | `claude`, `qwen36` |
| `account_kind` | `anthropic` (claude), `openai_compat` (hosted) o `local` (127.0.0.1/localhost/LAN) | `local` |
| `backend` | host del `baseURL` del perfil o `api.anthropic.com` | `localhost:8090` |
| `model` | argumento sin prefijo, o el modelo de la sesión | `claude-haiku-4-5-20251001` |
| `routed` | `true` si la cuenta de la petición no es la de la sesión | `true` |
| `session_account` | cuenta de la sesión | `qwen36` |
| `agent.type` / `agent.id` | contexto del subagente si existe (`LocalAgentTaskState`) | `general-purpose` |

Es una función pura sobre `(scope, sessionEnv, model)`, con test unitario de tabla.

### 2.2 Dos sinks (`src/utils/telemetry/sinks.ts`, nuevo)

Cada sink tiene su configuración, su `MeterProvider`, su `LoggerProvider` y su filtro.

**Sink corporativo**

- Configuración: las variables `OTEL_*` estándar (las de remote/managed settings). Si la persona
  tiene `OTEL_*` propias en su settings de usuario, las managed tienen prioridad, como en Claude
  Code.
- Se activa si `CLAUDE_CODE_ENABLE_TELEMETRY=1` y no hay un `DISABLE_TELEMETRY` *de origen
  humano o managed* (ver 1.3). El que inyecta `profiles.ts` se marca: el perfil pone además
  `FNHARNESS_TELEMETRY_SUPPRESSED_BY_PROFILE=1`, o mejor, el perfil deja de ponerlo y
  `privacyLevel` consulta el perfil.
- Filtro: solo registros con `account` en `corpAccounts` (por defecto `["claude"]`, decisión D1).
- Atributos: **solo el esquema oficial** (`model`, `type`, `speed`, `decision`, `tool_name`… más los
  de `getTelemetryAttributes()`). No se envían `account`, `backend`, ni nombres de modelos locales.
  Para IT parece Claude Code normal.
- `OTEL_LOG_USER_PROMPTS` y `OTEL_LOG_TOOL_DETAILS`: se respetan tal como los fije IT (hoy
  apagados). fnharness nunca los enciende para este sink.

**Sink propio**

- Configuración con un prefijo propio, para no pisar ni leer las de IT:
  `FNHARNESS_OTEL_ENDPOINT`, `FNHARNESS_OTEL_PROTOCOL` (`http/json` por defecto),
  `FNHARNESS_OTEL_HEADERS`, `FNHARNESS_OTEL_METRICS_INTERVAL_MS`, `FNHARNESS_OTEL_LOG_USER_PROMPTS`
  y `FNHARNESS_OTEL_LOG_TOOL_DETAILS`. Vive en `settings.json` de usuario (`env`) o en
  `accounts.json` (decisión D3).
- Filtro: ninguno, todas las cuentas.
- Atributos: el esquema oficial más `fnharness.account`, `fnharness.account_kind`,
  `fnharness.backend`, `fnharness.routed`, `fnharness.session_account`, `agent.type`, `pc` (de
  `~/.fn_pc`) y `session.id` siempre (aunque IT ponga `OTEL_METRICS_INCLUDE_SESSION_ID=false`).
- Costes de cuentas locales: 0 USD (como `calculateUSDCost`), pero los tokens se cuentan.

### 2.3 Contadores duales

`setMeter` recibe un `createCounter` que crea el instrumento en ambos meters y devuelve un
`AttributedCounter` cuyo `add(value, attrs)`:

1. Calcula `ctx = resolveTelemetryCtx(attrs.model)`.
2. Si el sink corporativo está activo y `ctx.account ∈ corpAccounts`, suma en el meter corporativo
   con `attrs` + atributos comunes.
3. Si el propio está activo, suma en el suyo con `attrs` + comunes + `fnharness.*`.

Las llamadas existentes no se tocan. `getXCounter()?.add(...)` sigue igual.

### 2.4 Métricas de sesión (no van ligadas a una petición)

`session.count`, `active_time`, `lines_of_code`, `commit`, `pull_request` y `code_edit_tool.decision`
no tienen modelo. Regla (decisión D2):

- Propio: siempre, con `fnharness.session_account` = cuenta de la sesión en ese momento.
- Corporativo: si la cuenta de la sesión es corporativa **o** la sesión ya ha hecho al menos una
  petición a una cuenta corporativa (un subagente `claude:` en una sesión `qwen36` cuenta). Se
  calcula con una marca `sessionTouchedCorp` en `bootstrap/state.ts`.

### 2.5 Eventos

`logOTelEvent(name, metadata)` emite un `LogRecord` con `event.name = claude_code.<name>`,
`event.timestamp`, `event.sequence` y los atributos, por el mismo reparto que los contadores. En el
sink corporativo, `user_prompt` lleva `prompt_length` y `prompt="<REDACTED>"` salvo que IT encienda
`OTEL_LOG_USER_PROMPTS`. En el propio, el texto solo va si `FNHARNESS_OTEL_LOG_USER_PROMPTS=1`.

### 2.6 Arranque, vaciado y fallos

- `initializeTelemetryAfterTrust()` llama a `initializeTelemetry()` después de que se acepte la
  confianza del directorio y del diálogo de managed settings. Si el diálogo se rechaza, el proceso
  ya sale (comportamiento de `securityCheck.tsx`).
- `flushTelemetry()` en la salida, con un tope de 2 s por sink, para no bloquear el cierre ni `-p`.
- Un destino caído no rompe la sesión: los errores del exportador van al log de depuración, nunca a
  la TUI. Nunca se imprime la cabecera `dd-api-key` ni otras cabeceras (se redactan en los logs).
- Intervalos: métricas cada 60 s (`OTEL_METRIC_EXPORT_INTERVAL`) y logs cada 5 s, como Claude Code.

## 3. Destino propio: `otel_sink` (si la decisión D4 es «lo montamos»)

App nueva `apps/otel_sink` (sub-repo `dataforge/otel_sink`), con una sola responsabilidad: un
receptor OTLP/HTTP con JSON que escucha en `127.0.0.1:4318` (`/v1/metrics`, `/v1/logs`) y escribe en
SQLite.

- Esquema (`migrations/001_init.sql`):
  - `metric_points(ts, name, value, account, account_kind, model, type, session_id, pc, attrs_json)`.
  - `events(ts, name, account, model, session_id, pc, attrs_json)`.
  - Índices por `(account, model, ts)`.
- Reutilizar antes de escribir: `open_llm_db_py_infra` y `log_llm_usage_py_infra` ya guardan uso de
  LLM con coste. Valorar escribir los `api_request` también en `llm_usage`, para que
  `summarize_llm_usage_py_infra` y el tab Monitor del `registry_dashboard` los vean sin código nuevo.
- Varios PCs: fase posterior. El receptor del VPS (`registry_api`) acepta el mismo OTLP, o se
  sincroniza con `fn sync`.
- Vista: un tab en `registry_dashboard` con coste y tokens por cuenta y modelo y por día, el
  porcentaje enrutado y el top de herramientas por éxito o fallo.

Alternativa sin código: exportar a un backend existente (Grafana/Loki/Prometheus o SigNoz) si ya lo
hay en el VPS.

## 4. Fases

| Fase | Contenido | Hecho cuando |
|---|---|---|
| 0 | Verificar `securityCheck.tsx` con `OTEL_*`; capturar en local lo que enviaría Claude Code oficial con las mismas variables (receptor falso) para fijar el esquema de referencia | Fichero `docs/otel_reference_capture.json` con métricas y eventos reales del binario oficial |
| 1 | `context.ts` + tests de tabla | `bun run test:unit` verde |
| 2 | `sinks.ts`, `instrumentation.ts` real, contadores duales, `initializeTelemetryAfterTrust` | e2e: un receptor falso recibe `claude_code.session.count` y `cost.usage` |
| 3 | `logOTelEvent` real + redacción de prompts | e2e: `api_request` y `user_prompt` (redactado) llegan |
| 4 | Filtro por cuenta + marca `sessionTouchedCorp` + `DISABLE_TELEMETRY` del perfil | e2e de enrutado: sesión en cuenta falsa A con subagente `claude:` falso → corp recibe solo lo de `claude`, propio recibe ambos |
| 5 | `otel_sink` (si D4) + tab del dashboard | Una sesión real deja filas por cuenta y modelo en SQLite |
| 6 | Prueba real contra Datadog | Ver sección 6 |

## 5. Pruebas

- **Unitarias**: `context.test.ts` (claude sin ámbito, ámbito qwen36, enrutado claude desde qwen36,
  local frente a hosted, prefijo `cuenta:modelo`); `sinks.test.ts` (filtro corp, atributos corp sin
  `fnharness.*`, redacción, precedencia managed > usuario, `DISABLE_TELEMETRY` humano frente al del
  perfil).
- **e2e** (`tests/e2e/otel.e2e.test.ts`): dos receptores OTLP falsos (corp y propio) y dos
  servidores de modelo falsos (`accta`, y `claude` simulado con `ANTHROPIC_BASE_URL`); intervalos de
  exportación a 200 ms. Se comprueba en cada receptor qué nombres, valores y atributos llegan, y que
  la API key de cabecera nunca aparece en stdout ni en el log de depuración.
- Cerrar sin que se cuelgue: `-p "hola"` termina en menos de 3 s con los dos destinos caídos.

## 6. Verificación con la empresa

- Sesión real en la cuenta `claude` → en Datadog deben aparecer `claude_code.cost.usage` y
  `claude_code.token.usage` con `user.email` corporativo. No tenemos acceso a Datadog: pedir a IT
  una captura o un sí, o comparar contra la captura de referencia de la fase 0 (mismo esquema que el
  binario oficial).
- Comprobar que sesiones `ollama` o `qwen36` sin subagentes `claude:` no generan nada en el
  corporativo.

## 7. Privacidad y cumplimiento

- Al destino corporativo nunca se envía más de lo que enviaría Claude Code con la misma
  configuración. Ni prompts, ni comandos, ni rutas, ni nombres de modelos locales.
- Tampoco se envía menos de lo que corresponde: todo uso de la cuenta Claude de empresa, incluidos
  los subagentes `claude:` desde otras cuentas, se reporta. No se debe usar fnharness para esquivar
  la medición corporativa; ese es el motivo del filtro por cuenta y no por sesión.
- El destino propio es local por defecto (`127.0.0.1`), y el texto de prompts solo se guarda si se
  activa explícitamente.

## 8. Riesgos

- **Cardinalidad** en el propio (modelo × cuenta × sesión): se acepta en local; en Datadog,
  `session.id` sigue la configuración de IT.
- **Desajuste de esquema** con Claude Code oficial: lo cubre la captura de referencia de la fase 0.
- **Coste fantasma**: `calculateUSDCost` en cuentas sin precio da 0; en el propio se marca
  `cost_known=false` para no confundir 0 con gratis.
- **Rendimiento**: el `add()` dual llama a `resolveTelemetryCtx` en cada punto; es O(1) y lee
  AsyncLocalStorage. Medir con `bun run dev` en una sesión larga.
- **Upstream**: si se sincroniza con Claude Code oficial, `instrumentation.ts` puede chocar. Mantener
  el código nuevo en ficheros nuevos y dejar `instrumentation.ts` como un despachador fino.

## 9. Decisiones abiertas

| Id | Pregunta | Opción por defecto propuesta |
|---|---|---|
| D1 | Qué cuentas van al corporativo | Solo `claude` (`corpAccounts=["claude"]`, configurable) |
| D2 | Métricas de sesión en el corporativo | Si la sesión es `claude` o ha tocado `claude` alguna vez |
| D3 | Dónde vive la configuración propia | `env` del `settings.json` de usuario del perfil (`~/.fnharness-work/settings.json`) |
| D4 | Backend propio | `otel_sink` local con SQLite, sumando `llm_usage`; alternativa: backend ya existente en el VPS |
| D5 | Prompts en el propio | Apagado por defecto (`FNHARNESS_OTEL_LOG_USER_PROMPTS=0`) |
| D6 | Trazas (`OTEL_TRACES_EXPORTER`, `sessionTracing.ts`) | Fuera de alcance en esta versión |
