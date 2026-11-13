# Varias cuentas Claude en un mismo arnés y telemetría OTel por cuenta y receptor

Plan ejecutable. Fecha: 11/11/2026 (v2: añade varias cuentas Claude en un arnés y receptores por
cuenta). Estado: sin empezar. Las decisiones abiertas están en la sección 11.

Objetivo, en tres partes:

1. **Varias cuentas Claude (OAuth de Anthropic) en un mismo arnés**, por ejemplo `claude-personal` y
   `claude-work`, junto a las cuentas OpenAI-compatible que ya existen (`qwen36`, `ollama`…). Hoy cada
   identidad Claude necesita su propio directorio de configuración (`~/.fnharness`,
   `~/.fnharness-work`).
2. **`/account` muestra de quién es cada cuenta**: identidad (correo y organización, o proveedor y
   URL), el modelo en uso o recordado, y a qué receptores de telemetría envía.
3. **Telemetría OTel con atribución por cuenta y modelo**, enviada a **cada receptor que corresponda a
   la cuenta que sirvió la petición**:
   - el receptor de la empresa de esa cuenta (el de sus *remote managed settings*, hoy Datadog EU para
     Acme);
   - el nuestro;
   - cualquier otro que se declare.

## 1. Estado actual (inventario del 11/11/2026)

### 1.1 La configuración corporativa llega, pero no se usa

- `~/.fnharness-work/remote-settings.json` trae en `env`:
  - `CLAUDE_CODE_ENABLE_TELEMETRY=1`;
  - `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.datadoghq.eu`, con `OTEL_EXPORTER_OTLP_HEADERS=dd-api-key=…`
    y `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`;
  - `OTEL_METRICS_EXPORTER=otlp` y `OTEL_LOGS_EXPORTER=otlp`;
  - `OTEL_METRICS_INCLUDE_SESSION_ID=false` y
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production`.

  Todas se aplican a `process.env` de toda la sesión.
- En el build OSS la telemetría está desactivada:
  - `src/utils/telemetry/instrumentation.ts`: `isTelemetryEnabled()` devuelve `false`, e
    `initializeTelemetry()`, `bootstrapTelemetry()` y `flushTelemetry()` están vacíos.
  - `src/utils/telemetry/events.ts`: `logOTelEvent()` no hace nada.
  - `src/entrypoints/init.ts:210`: `initializeTelemetryAfterTrust()` vuelve sin hacer nada. Lo llama
    `main.tsx:2644`.
- **Consecuencia: hoy IT no recibe nada de fnharness**, ni siquiera del uso de la cuenta Claude de
  empresa.

### 1.2 Lo que sigue vivo (solo falta conectarlo)

| Pieza | Dónde | Notas |
|---|---|---|
| Contadores | `src/bootstrap/state.ts` (`setMeter`, l. 961) | `claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `cost.usage`, `token.usage`, `code_edit_tool.decision`, `active_time.total` (`AttributedCounter`) |
| Coste y tokens | `src/cost-tracker.ts:291` (`addToTotalSessionCost`) | Atributos `{ model, speed? }`; tokens por `type` |
| LOC, commits, PR | `utils/diff.ts:72`, `tools/shared/gitOperationTracking.ts` | |
| Decisiones de edición | `services/tools/toolExecution.ts:976`, `hooks/toolPermission/permissionLogging.ts:216` | |
| Tiempo activo | `utils/activityManager.ts` | |
| Eventos | `logOTelEvent(...)` | `user_prompt`, `api_request`, `api_error`, `tool_result`, `tool_decision`, `hook_execution_*`, `feedback_survey` |
| Atributos comunes | `utils/telemetryAttributes.ts` | `user.email`, `organization.id`, `user.account_uuid` salen de `getOauthAccountInfo()`, que hoy solo conoce **una** identidad OAuth |
| SDK | `package.json` | `@opentelemetry/*` completo |
| Diálogo de seguridad | `services/remoteManagedSettings/securityCheck.tsx` | `checkManagedSettingsSecurity` bloquea si cambian ajustes peligrosos |

### 1.3 Modelo de cuentas actual

- `src/services/api/openai-compat/accounts.ts`:
  - `accounts.json` (0600) vive en `$CLAUDE_CONFIG_DIR`.
  - `StoredAccount` tiene `provider`, `label`, `baseUrl`, `apiKey | apiKeyRef`, `model`,
    `smallModel` y `contextProfile`.
  - `CLAUDE_ACCOUNT_ID = 'claude'` es la **única** cuenta Anthropic; es implícita, no está en
    `accounts.json`.
- Por cada `CLAUDE_CONFIG_DIR` hay una sola copia de estos ficheros: credenciales OAuth
  (`.credentials.json`), `remote-settings.json` (`services/remoteManagedSettings/syncCacheState.ts`)
  y `policy-limits.json` (`services/policyLimits/index.ts`). Por eso hoy dos identidades Claude
  necesitan dos directorios y dos lanzadores.
- Enrutado por petición (`account_routing.md`): `ProfileScope` (AsyncLocalStorage) dice qué cuenta
  sirve cada petición. `calculateUSDCost` ya lo usa.
- `profiles.ts:374`: una cuenta OpenAI-compatible activa pone `DISABLE_TELEMETRY ||= '1'`, y
  `utils/privacyLevel.ts` lo convierte en `no-telemetry`. Si se respetara tal cual, se perdería el
  consumo de un subagente `claude-work:` lanzado desde una sesión `qwen36`.

## 2. Varias cuentas Claude en un arnés

### 2.1 Tipo de cuenta nuevo: `anthropic`

`StoredAccount` gana `kind: 'anthropic' | 'openai_compat'` (por defecto `openai_compat`, para que
los `accounts.json` actuales sigan valiendo).

Una cuenta `anthropic` guarda su estado en `<config>/accounts/<id>/`:

| Fichero | Contenido |
|---|---|
| `credentials.json` (0600) | tokens OAuth de esa cuenta (mismo formato que `.credentials.json`) |
| `oauth-account.json` | `emailAddress`, `organizationUuid`, `organizationName`, `accountUuid` y plan (lo que hoy devuelve `getOauthAccountInfo()`) |
| `remote-settings.json` | *remote managed settings* de **su** organización |
| `policy-limits.json` | límites de política de su organización |

Migración sin pérdida: al arrancar, si existe `.credentials.json` en la raíz y no hay ninguna cuenta
`anthropic`, se registra como `claude` y sus ficheros se **copian** (no se mueven) a
`accounts/claude/`. Así `~/.fnharness-work` sigue funcionando y la cuenta implícita `claude` sigue
existiendo.

Se puede importar un directorio existente: `/account import ~/.fnharness-work --as claude-work`
copia sus credenciales y su caché de settings.

### 2.2 Alta, sesión y renovación

- `/account add claude <id>` lanza el login OAuth normal (`/login`), pero escribe en
  `accounts/<id>/` en vez de la raíz.
- El refresco de token es por cuenta: `getClaudeAIOAuthTokens(accountId)`. Cada cuenta refresca la
  suya con un cerrojo de fichero propio, sin pisar a las demás.
- `/logout <id>` borra solo esa carpeta, previa confirmación.

### 2.3 Enrutado

- `routeForModel` reconoce cualquier cuenta `kind: anthropic` igual que hoy `claude`:
  `claude-work:sonnet` resuelve los alias contra las variables de modelo originales y usa el token
  de esa cuenta.
- `ProfileScope` amplía el ámbito: además del perfil OpenAI-compatible, lleva `anthropicAccountId`.
  Dentro del ámbito, `getOauthAccountInfo()` y `getClaudeAIOAuthTokens()` responden por esa cuenta.
- `isClaudeAISubscriber()` y `getAllModelBetas` siguen como en `account_routing.md`, pero por la
  cuenta del ámbito.

### 2.4 Remote managed settings y políticas por cuenta

Se aplican a la cuenta, no al proceso:

- **Telemetría** (`env` con `OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`): se convierte en un receptor
  ligado a esa cuenta (sección 4). **Deja de escribirse en `process.env`**, para no mezclar
  receptores entre cuentas.
- **Resto de ajustes y políticas** (permisos, herramientas o modelos prohibidos, límites). Regla
  conservadora (decisión D7): una política de una cuenta corporativa aplica a **toda la sesión**
  mientras esa cuenta esté en uso en ella (es la de la sesión o ya ha servido alguna petición).
  Si hay varias, se combinan quedándose con lo más restrictivo. Usar otra cuenta no debe servir para
  esquivar la política de la empresa en su máquina.
- El diálogo de `securityCheck.tsx` se muestra **por cuenta** la primera vez que esa cuenta trae
  ajustes peligrosos o cuando cambian, con su nombre y organización en la cabecera. Rechazarlo
  desactiva esa cuenta; no cierra el arnés si hay otras cuentas listas. Si la cuenta rechazada es la
  de la sesión, el arnés sale, como ahora.

## 3. `/account`: de quién es cada cuenta

El panel muestra, por cuenta, una cabecera de identidad y debajo el modelo y los receptores:

```
  Cuentas
  ── claude-work · Claude (Anthropic) ● sesión ──────────────────────
     user@example.com · Acme (org 3f2a…) · plan Team
     modelo: claude-opus-5-5 (recordado: opus)        ✓ lista
     telemetría → work:datadog-eu (corporativo) · propio
  ── claude-personal · Claude (Anthropic) ─────────────────────────────
     yo@gmail.com · personal · plan Max
     modelo: sonnet                                     ✓ lista
     telemetría → propio
  ── qwen36 · llama.cpp local ─────────────────────────────────────────
     http://localhost:8090/v1
     modelo: qwen36-35b-heretic-q4km                    ✓ responde
     telemetría → propio
  ── ollama · Ollama ──────────────────────────────────────────────────
     http://localhost:11434 · sin servidor              ✗ no responde
```

- Identidad: en `anthropic`, `emailAddress · organizationName · plan` de `oauth-account.json`; en
  `openai_compat`, `provider · baseUrl` (y el titular de la clave si el proveedor lo expone).
- Diferenciación por modelo: el modelo en uso (sesión) o recordado (`StoredAccount.model`), y la
  cuenta y el modelo de cada subagente vivo enrutado a ella (`[cuenta] modelo` en el panel de agentes,
  que ya existe).
- Receptores: los ids de los receptores ligados (sección 4), marcando el corporativo.
- `/model` (`UnifiedModelPicker`) usa la misma cabecera de identidad abreviada:
  `── claude-work · user@example.com ──`.
- La statusline añade la cuenta: `FNHARNESS_ACCOUNT` ya existe; se añade `FNHARNESS_ACCOUNT_EMAIL`
  para las `anthropic`.

## 4. Telemetría: receptores por cuenta

### 4.1 Receptores (`telemetrySinks`)

Un receptor es un destino OTLP con nombre. Hay dos orígenes:

| Origen | Cómo nace | Editable |
|---|---|---|
| `managed:<cuenta>` | De las `remote-settings` de una cuenta `anthropic` (sus `OTEL_*`). Id: `<cuenta>:<host>`, p. ej. `claude-work:otlp.datadoghq.eu` | No: lo dicta su organización |
| `user` | Declarado en `<config>/telemetry.json` (0600) | Sí, con `/telemetry` |

Ejemplo de `telemetry.json`:

```json
{
  "sinks": {
    "propio": {
      "endpoint": "http://127.0.0.1:4318",
      "protocol": "http/json",
      "headersRef": null,
      "accounts": "*",
      "schema": "enriched",
      "logUserPrompts": false,
      "logToolDetails": true,
      "metricsIntervalMs": 60000
    },
    "socio-x": {
      "endpoint": "https://otel.socio-x.example",
      "protocol": "http/protobuf",
      "headersRef": "pass:apis/socio-x-otel",
      "accounts": ["claude-socio"],
      "schema": "official"
    }
  }
}
```

- `headersRef` usa el mismo gestor de secretos que `apiKeyRef` (`services/secrets`). Las cabeceras
  nunca se escriben en claro ni se imprimen.
- `accounts`: `"*"` o una lista de ids de cuenta.
- `schema`:
  - `official`: solo el esquema de Claude Code, sin atributos `fnharness.*`.
  - `enriched`: añade los `fnharness.*` de la sección 4.3.

  Los receptores `managed:*` son siempre `official`.
- Prompts y detalle de herramientas: en un receptor `managed`, solo lo que diga su organización; en
  uno `user`, solo si se activa en ese receptor.

### 4.2 Reparto

```
call site ─ add()/logOTelEvent() ─▶ ctx = resolveTelemetryCtx(model)
                                     │
                                     ├─ sinksFor(ctx.account) ──▶ [claude-work:datadog, propio]
                                     │       └─ por receptor: atributos según schema ─▶ su MeterProvider/LoggerProvider ─▶ OTLP
                                     └─ (nada más: un receptor solo ve las cuentas que tiene ligadas)
```

- `sinksFor(account)` = receptores `managed:<account>` + receptores `user` con `accounts` que la
  incluya. Es una función pura con test de tabla.
- Cada receptor tiene su `MeterProvider` y su `LoggerProvider`, con su resource
  (`OTEL_RESOURCE_ATTRIBUTES` del receptor managed o `service.name=fnharness` en los propios).
- `AttributedCounter` dual pasa a ser N-ario: `setMeter` recibe un `createCounter` que crea el
  instrumento en cada receptor activo, y `add(value, attrs)` solo suma en `sinksFor(ctx.account)`.
  Los receptores que se añaden en caliente (`/telemetry add`, login de una cuenta nueva) se crean
  perezosamente al primer uso.
- **Identidad por receptor**: `user.email`, `organization.id` y `user.account_uuid` salen de
  `oauth-account.json` **de la cuenta de la petición**. Un registro que va al receptor de Acme nunca
  lleva el correo de la cuenta personal, y viceversa.

### 4.3 Contexto por petición (`src/utils/telemetry/context.ts`, nuevo, puro)

| Campo | Fuente | Ejemplo |
|---|---|---|
| `account` | `ProfileScope` (OpenAI-compatible o `anthropicAccountId`); sin ámbito, la cuenta de la sesión | `claude-work`, `qwen36` |
| `account_kind` | `anthropic`, `openai_compat` o `local` (localhost/LAN) | `local` |
| `backend` | host del `baseURL` o `api.anthropic.com` | `localhost:8090` |
| `model` | argumento sin prefijo, o el de la sesión | `claude-haiku-4-5-20251001` |
| `routed` | la cuenta de la petición ≠ la de la sesión | `true` |
| `session_account` | cuenta de la sesión | `qwen36` |
| `agent.type` | contexto del subagente (`LocalAgentTaskState`) | `general-purpose` |

En el esquema `enriched` van como `fnharness.account`, `fnharness.account_kind`,
`fnharness.backend`, `fnharness.routed`, `fnharness.session_account`, `agent.type`, `pc` (de
`~/.fn_pc`) y `session.id` siempre.

### 4.4 Métricas de sesión (sin modelo)

`session.count`, `active_time`, `lines_of_code`, `commit`, `pull_request` y `code_edit_tool.decision`
van a la unión de `sinksFor(a)` para cada cuenta `a` que la sesión ha usado hasta ese momento: la de
la sesión más cada cuenta que haya servido una petición. Se lleva con `sessionAccountsTouched` en
`bootstrap/state.ts`. Un receptor que entra a mitad de sesión recibe `session.count=1` en ese
momento (decisión D2).

### 4.5 `DISABLE_TELEMETRY` y privacidad

- `profiles.ts` deja de poner `DISABLE_TELEMETRY`. Pone `FNHARNESS_PROFILE_NO_TELEMETRY=1`, que solo
  apaga la telemetría no esencial **del proveedor** (nada que ver con OTel).
- `DISABLE_TELEMETRY` puesto por la persona apaga **los receptores `user`**. Los `managed` los apaga
  solo su organización. Saltarse la medición corporativa no es una opción del arnés.
- Prompts: `<REDACTED>` salvo que el receptor lo permita (sección 4.1).

### 4.6 Arranque, vaciado y fallos

- `initializeTelemetryAfterTrust()` construye los receptores tras la confianza del directorio y los
  diálogos de seguridad de cada cuenta.
- `flushTelemetry()` al salir, en paralelo y con un tope de 2 s por receptor.
- Un receptor caído solo deja una entrada en el log de depuración. Nunca se imprime una cabecera.
- `/telemetry` lista los receptores, sus cuentas, el último envío correcto y el último error (hoy existe la versión informe, `/otel`, que no envía nada: `src/utils/telemetry/otelReport.ts`).
  `/telemetry test <id>` manda un punto de prueba.

## 5. Nuestro receptor: `otel_sink` (si D4 = «lo montamos»)

App nueva `apps/otel_sink` (sub-repo `dataforge/otel_sink`): un receptor OTLP/HTTP con JSON en
`127.0.0.1:4318` (`/v1/metrics`, `/v1/logs`) que escribe en SQLite.

- Esquema `migrations/001_init.sql`:
  - `metric_points(ts, name, value, account, account_kind, model, type, session_id, pc, attrs_json)`;
  - `events(ts, name, account, model, session_id, pc, attrs_json)`;
  - índices por `(account, model, ts)`.
- Reutilizar: `open_llm_db_py_infra` y `log_llm_usage_py_infra` ya guardan uso de LLM con coste.
  Escribir también los `api_request` en `llm_usage`, para que `summarize_llm_usage_py_infra` y el tab
  Monitor del `registry_dashboard` los vean.
- Vista: tab en `registry_dashboard` con coste y tokens por cuenta y modelo y por día, % enrutado y
  herramientas por éxito o fallo.
- Varios PCs: fase posterior (receptor en `registry_api` o `fn sync`).

## 6. Fases

| Fase | Contenido | Hecho cuando |
|---|---|---|
| 0 | Captura de referencia: binario oficial de Claude Code con las mismas `OTEL_*` contra un receptor falso. Comprobar que `securityCheck.tsx` salta con `OTEL_*` | `docs/otel_reference_capture.json` |
| 1 | Cuentas `anthropic`: `kind`, `accounts/<id>/`, migración por copia, login, logout y refresco por cuenta, `/account import` | e2e: dos cuentas Anthropic falsas (`ANTHROPIC_BASE_URL` a dos servidores) con tokens distintos; cada petición lleva el suyo |
| 2 | Enrutado `anthropicAccountId` en `ProfileScope`; `getOauthAccountInfo` por ámbito | e2e: sesión en A, subagente `B:sonnet` llega a B con el token de B |
| 3 | Remote settings y políticas por cuenta; diálogo por cuenta; el `env` OTel deja de ir a `process.env` | Test: rechazar el diálogo de B desactiva B y no cierra la sesión de A |
| 4 | `/account` con identidad, modelo y receptores; cabecera en `/model`; statusline | Captura en pseudo-terminal con 3 cuentas |
| 5 | `context.ts`, `sinks.ts` (`sinksFor`, `telemetry.json`), contadores N-arios, `logOTelEvent` real | Unitarias verdes |
| 6 | Reparto por cuenta + `sessionAccountsTouched` + `DISABLE_TELEMETRY` | e2e de la sección 7 |
| 7 | `/telemetry` (list, add, test). **Ya existe en versión informe** (13/11/2026): `/otel`, alias `/opentelemetry` y `/telemetry`, solo lectura (estado del build, cuenta, `OTEL_*` con origen, destinos, `telemetry.json`); faltan `add`, `test` y el último envío/error | Captura en pseudo-terminal |
| 8 | `otel_sink` + tab del dashboard (si D4) | Sesión real deja filas por cuenta y modelo |
| 9 | Prueba real con la empresa | Sección 8 |

Las fases 1 a 4 (cuentas) y 5 a 7 (telemetría) se pueden hacer en ramas separadas. La 6 necesita la
2, porque la cuenta Anthropic de cada petición sale del ámbito.

## 7. Pruebas

- **Unitarias**:
  - `context.test.ts`: sin ámbito, ámbito OpenAI-compatible, ámbito Anthropic B desde sesión A, local
    frente a hosted.
  - `sinks.test.ts`: `sinksFor` con `"*"` y listas; atributos `official` sin `fnharness.*`; identidad
    por cuenta; redacción; `DISABLE_TELEMETRY` humano frente al del perfil.
  - `accounts.test.ts`: migración por copia, idempotente; `kind` por defecto.
- **e2e** (`tests/e2e/otel_multiaccount.e2e.test.ts`):
  - Montaje: tres receptores OTLP falsos (`corpA` como managed de la cuenta A, `corpB` como managed
    de B y `propio`), dos servidores Anthropic falsos (A y B) y uno OpenAI-compatible (`acctc`).
    Intervalos a 200 ms.
  - Escenario: sesión en `acctc` que lanza un subagente `A:sonnet` y otro `B:haiku`.
  - Esperado:
    - `corpA` solo ve lo de A, con el correo de A;
    - `corpB` solo ve lo de B, con el correo de B;
    - `propio` ve las tres cuentas, con `fnharness.routed=true` en A y B;
    - ninguna cabecera aparece en stdout ni en el log de depuración.
- **Salida rápida**: `-p "hola"` termina en menos de 3 s con todos los receptores caídos.

## 8. Verificación con la empresa

- Sesión real en `claude-work`: en Datadog deben aparecer `claude_code.cost.usage` y `token.usage`
  con `user.email` de Acme. No tenemos acceso a Datadog: pedir confirmación a IT o comparar con la
  captura de la fase 0.
- Sesiones de cuentas personales o locales sin subagentes `claude-work:` no generan nada en el
  receptor de Acme.

## 9. Privacidad y cumplimiento

- A un receptor corporativo nunca va más de lo que enviaría Claude Code con la misma configuración:
  ni prompts, ni comandos, ni rutas, ni nombres de modelos o cuentas ajenas, ni la identidad de otra
  cuenta.
- Tampoco va menos: todo uso de una cuenta corporativa, incluidos los subagentes enrutados desde
  otras cuentas, llega a su receptor. Sus políticas se aplican mientras esa cuenta esté en uso.
- Cada cuenta del arnés pertenece a su titular y se usa según los términos de su plan. Tener varias
  cuentas en el mismo arnés es para la misma persona con identidades distintas (trabajo y personal,
  o varios clientes), no para compartir suscripciones entre personas.
- Nuestro receptor es local por defecto. El texto de los prompts solo se guarda si se activa en ese
  receptor.

## 10. Riesgos

- **Superficie de credenciales**: N carpetas con tokens OAuth. Todas en 0600, con refresco aislado
  por cerrojo; `fn doctor` (o `/account doctor`) comprueba permisos.
- **Fuga de identidad entre cuentas** (correo de una en el receptor de otra): lo cubren el test de
  identidad por cuenta y el e2e.
- **Políticas combinadas** demasiado restrictivas en sesiones mixtas: se acepta (D7). `/account`
  dice qué cuenta impone cada restricción.
- **Desajuste de esquema** con Claude Code oficial: captura de la fase 0.
- **Cardinalidad** en `enriched`: se acepta en local.
- **Upstream**: el código nuevo va en ficheros nuevos (`context.ts`, `sinks.ts`,
  `anthropicAccounts.ts`); `instrumentation.ts` y `auth.ts` quedan como despachadores finos.

## 11. Decisiones abiertas

| Id | Pregunta | Opción por defecto propuesta |
|---|---|---|
| D1 | Qué cuentas van a cada receptor corporativo | Solo la cuenta dueña de esas `remote-settings` |
| D2 | Métricas de sesión | A los receptores de todas las cuentas que la sesión ha usado |
| D3 | Dónde se configuran los receptores propios | `<config>/telemetry.json` (0600) con `/telemetry` |
| D4 | Nuestro receptor | `otel_sink` local con SQLite, sumando `llm_usage`; alternativa: backend existente en el VPS |
| D5 | Prompts en el receptor propio | Apagado por defecto, activable por receptor |
| D6 | Trazas (`sessionTracing.ts`) | Fuera de alcance en esta versión |
| D7 | Políticas corporativas en sesiones mixtas | Lo más restrictivo de todas las cuentas usadas en la sesión |
| D8 | ¿Se unifican `~/.fnharness` y `~/.fnharness-work`? | Sí, con `/account import`, pero sin borrar los directorios viejos hasta validarlo |
