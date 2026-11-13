# Changelog de FnHarness

## Sin publicar

### Novedades

- varias cuentas Claude (OAuth de Anthropic) en un mismo arnés: `kind: "anthropic"` en `accounts.json` con su estado en `<config>/accounts/<id>/` (0600/0700); `/account import <dir> --as <id>` copia el login de otro directorio (p. ej. `~/.fnharness-work`) sin tocarlo, `/account add claude <id>` hace el login OAuth hacia esa carpeta, `/logout <id>` cierra solo esa cuenta y `/account doctor [--fix]` revisa permisos; `claude-work:sonnet` enruta un agente a otra cuenta con su token, y `/account <id>` o `/model` cambian la sesión; cada cuenta renueva su token con su propio cerrojo; `/account` (también con `-p`) muestra por cuenta correo, organización, plan, modelo y estado, y `/model` la identidad en la cabecera; ajustes gestionados y políticas por cuenta, combinados con lo más restrictivo de las cuentas en uso, y su telemetría deja de ir a `process.env`; ajustes peligrosos nuevos de otra cuenta a mitad de sesión esperan a `/account approve <id>` (rechazar desactiva esa cuenta, la sesión sigue); la primera vez, `/account` registra `claude` copiando su login a `accounts/claude/` sin tocar la raíz; los comandos `local-jsx` con `supportsNonInteractive` imprimen su resultado con `-p`
- las herramientas nativas `WebSearch` y `WebFetch` quedan desactivadas por defecto (solo funcionan con la API de Anthropic y cuestan dinero): se sustituyen por las del MCP `web_search` (`mcp__web_search__web_search` y `mcp__web_search__web_fetch`), que citan ahora los agentes integrados `claude-code-guide` y `verification`; `FNHARNESS_NATIVE_WEB=1` las reactiva
- `/otel` (alias `/opentelemetry` y `/telemetry`): informe de solo lectura de qué pasa con la telemetría y a dónde se enviaría (estado del build, cuenta, variables `OTEL_*` con su origen, destinos, receptores propios de `telemetry.json`); las cabeceras salen siempre enmascaradas y `--json` da el mismo informe en JSON; no implementa todavía el envío real
- la barra de estado muestra el correo de la cuenta en la línea de cuenta (cuenta Claude con OAuth; con el binario oficial lo lee de `<config>/.claude.json`) para distinguir de un vistazo la cuenta personal de la de empresa; el bloque `fnharness.account` lleva ahora `email` y `org`
- selector de sesiones de toda la máquina: `←` con el prompt vacío (o `ctrl+x ctrl+w`) abre una lista agrupada por estado de las sesiones de fnharness y de Claude Code, las bg, las salas de Element sobre tmux y las ventanas de kitty, con filtro por palabras; `Enter` salta (enfoca kitty o adjunta tmux), `→` abre el detalle con reanudar o bifurcar aquí, enviar mensaje y parar; nuevo comando `/sesiones [--json] [--todas]`; el lanzador acepta `--chdir` en el reinicio y `BgSessionsDialog` desaparece
- perfiles de contexto: `/perfil` y `--perfil <nombre>` agrupan system prompt, herramientas y contexto (CLAUDE.md, memoria, hooks, MCP, skills) en un nombre, con cuenta y modelo opcionales; de fábrica `full`, `simple` y `minimo` (modelos locales de 16k), los tuyos en `<config>/profiles/<nombre>.json`; todo se aplica en caliente salvo cambiar `bare` o reactivar los hooks, que reinicia la sesión a través del lanzador; `/perfil nuevo <nombre>` guarda la sesión actual como perfil y la barra de estado muestra el perfil activo (`nombre*` si se tocó el scope)
- la lista de to-dos (`TaskCreate`/`TaskList`) es por proyecto: el lanzador fija `CLAUDE_CODE_TASK_LIST_ID` desde el repo git principal del directorio de arranque (sus worktrees comparten lista) y sobrevive al cerrar la sesión; fuera de git o con `FNHARNESS_TASK_LIST_PER_SESSION=1` sigue siendo por sesión
- cuentas, claves (`keyRef`), presets de proveedor, modelos Claude y tarifas salen de `accounts.json`, `providers.json` y `claude-models.json`, con recarga en caliente
- Sonnet 5.5 y Opus 5.5 como modelos por defecto de los alias `sonnet` y `opus`, con tarifa y ventana de 1M
- Haiku 5.5 y Fable 5.1 en `claude-models.json` (el alias `haiku` pasa a Haiku 5.5); Haiku 5.5 cobra el tramo de prompts de más de 100k tokens con `longPromptTokens` y `longPricing`
- el contexto de una cuenta (p. ej. Venice) completa la caché de models.dev con el snapshot cuando el proveedor falta
- la herramienta `Agent` exige `model` como `cuenta:modelo` en cada llamada (alias sueltos, ids sin cuenta y cuentas sin modelo se rechazan), así el modelo que lanza un agente elige siempre cuenta y modelo y puede delegar en otras cuentas; `/fork` y `/subtask` sin `--model` usan los de la sesión
- un nivel de agentes anidados: un subagente de la sesión principal puede lanzar agentes (de cualquier cuenta) en primer plano; esos ya no pueden lanzar más
- las sesiones de la misma máquina se comunican: cada una escucha en un socket UDS, la herramienta `ListPeers` y `/peers` listan las vivas con pid, id de sesión, estado y cwd, y `SendMessage` (`uds:…`, `peer:<pid|sesión|nombre>` o `parent`) o `/peers send` les dejan un mensaje en la cola; una sesión lanzada desde otra conoce a su padre y se le pide enviarle el resultado al terminar
- `SendMessage` siempre disponible, también sin equipos de agentes: continúa un subagente por su `agentId`
- los subagentes siempre responden a su padre: si terminan el turno sin texto se les pide una vez el informe final, y si aun así paran sin él el padre recibe un aviso con su último texto en vez de un resultado vacío

### Correcciones

- la API rechazaba los modelos 5.x (`claude_code_version_too_old`): el cliente anuncia ahora la versión 2.1.280 como mínimo (`FNHARNESS_API_VERSION` la sobrescribe)
- tarifas oficiales de Sonnet 5.5 (2/10) y Opus 5.5 (4/20, rápido 8/40), con la caché de lectura al 0.05x; se añaden los modelos 5, 4.7 y 4.8 y Fable 5

## v0.9.0 (25/10/2026)

### Novedades

- sesiones en segundo plano con --bg, ps, logs, stop, attach, rm y /background
- PushNotification local con notify-send y aviso en la TUI de respaldo
- paridad con Claude Code 2.1.310 en el panel de subagentes
- comandos /fork y /subtask para lanzar subagentes en segundo plano
- eventos UserPromptExpansion y MessageDisplay y tipo de hook mcp_tool
- Esc cancela la espera de un /loop autopaced con el aviso Pending wakeup cancelled
- barra por cuenta con ventana real, servidor, velocidad y coste
- cuenta predeterminada al abrir, con /account default y --set-default
- línea de velocidad (TTFT, lectura, generación, especulación) para modelos locales
- enganchar el canal de eventos al REPL, al modo -p, a /clear y a los diálogos
- emisor puro y capa de efectos del canal de eventos
- scripts/sync_env.sh para alinear ~/.fnharness con la config de Claude Code

### Correcciones

- el meta.json del subagente guarda el toolUseId de la llamada Agent
- /clear actualiza el sessionId de sessions/<pid>.json
- bin/fnharness acepta --account en cualquier posición
- el harness e2e respeta el ancho del pty y los saltos de cursor
- instalador propio desde Gitea en lugar del de claude-multimodel

### Documentación

- estado del paquete pequeño (Esc en /loop, hooks nuevos, PushNotification local)
- cuenta predeterminada y nueva barra de estado
- estado de las fases y runbook de migración de la fase 6
- avisa de recompilar el cli del árbol principal tras los arreglos del piloto
- resultado del piloto de la fase 5 con el puente de Matrix
- contrato implementado, uso de las variables y nota en FEATURES
- resultado de la fase 1 en los riesgos abiertos del plan de Matrix
- guia de sync_env y tabla de compatibilidad de hooks del dueno
- README del repo y repo_url en app.md
- plan de arnés por defecto en Matrix y contrato de eventos v1

### Tests

- esperar a sessions/<pid>.json antes de leerlo en el test de /clear
- /fork y /subtask toleran el repintado parcial de la fila del panel
- reglas PREGUNTA y ECO en el backend OpenAI falso
- e2e del canal de eventos con TUI en pseudo-terminal y backend falso
- contrato e2e del puente de Matrix (stream-json, flags de arranque, resume)
- pruebas de sync_env.sh sobre un HOME temporal

## v0.8.0 (24/10/2026)

### Novedades

- Simple incluye Agent y usa prompt de sistema y descripciones de tools compactos
- /model con los modelos de todas las cuentas conectadas
- subagentes en otra cuenta con model cuenta:modelo
- enrutado por petición con cuenta:modelo
- avisar al modelo cuando cambian las tools de un servidor
- autorreconexion de servidores stdio con backoff y contador de estabilidad
- comando /scope, Ctrl+Tab e indicador ctx en el pie
- aplicar el perfil a tools, MCP, skills y prompt en cada turno
- perfil de contexto puro y su persistencia por cuenta
- vigilancia de .mcp.json, .claude.json y settings con recarga en caliente
- /mcp reload y /mcp reconnect all con poda de servidores eliminados
- panel de subagentes bajo el prompt, navegable y con vista de transcript
- arrancar en bypassPermissions por defecto
- el modo default se muestra como «simple mode»

### Documentación

- medidas de Simple compacto y prueba con qwen36 en el plan del perfil de contexto
- enrutado por cuenta y /model unificado
- perfil de contexto, /scope y medidas por preset
- plan de recarga en caliente de servidores MCP
- estado del roadmap tras v0.7.0

### Tests

- enrutado por cuenta con dos servidores falsos
- el panel de agentes fuerza el perfil full
- perfil de contexto contra el servidor falso y Ctrl+Tab en pty

## v0.7.0 (24/10/2026)

### Novedades

- cadena de fallback entre cuentas y PostToolBatch en el bucle
- eventos PostToolBatch, DirectoryAdded, PreModelSwitch y PostModelSwitch
- /reload-skills reescanea skills sin reiniciar
- comando /goal con evaluador por turno y cuenta de juez configurable
- /autocompact y --autocompact con umbral configurable por sesión
- /recap, resumen de una línea de la sesión bajo demanda
- selector de /account con secciones Cuentas activas y Añadir cuenta
- bypassPermissions entra en el ciclo de Shift+Tab
- /cd mueve la sesión a otro directorio conservando la conversación
- --safe-mode, arranque de diagnóstico sin CLAUDE.md, skills, hooks, MCP ni plugins

### Correcciones

- prompt de arranque sin sugerir tareas recurrentes y trazas de depuración
- ignorar un TMUX heredado fuera de tmux
- defaultMode "auto" de Claude Code nuevo se lee como default
- fecha local en el changelog

## v0.6.0 (24/10/2026)

### Novedades

- tool Monitor, MONITOR_TOOL en el build por defecto
- laboratorio HTML con fnharness real (ttyd) y sidebar de mocks
- AGENT_TRIGGERS por defecto, ScheduleWakeup y /loop autopaced
- modo mock FNHARNESS_MOCKS que aplica estados falsos al AppState en caliente
- contador de cuentas conectadas y modelos en la cabecera
- /model lista los modelos de la cuenta activa y /account catalog|add <proveedor>
- catálogo models.dev con snapshot embebido, caché de 24 h y límites por modelo
- bienvenida mínima con solo el tema y sin login obligatorio de Anthropic

### Correcciones

- los contadores de la cabecera salen con su valor desde el arranque
- /model legible con modelos locales
- los mocks no pisan los contadores reales de la cabecera por defecto
- los mocks se reaplican al store mas reciente y la recarga sobrevive al rename atomico
- ocultar el control de effort con cuentas OpenAI-compatibles
- márgenes de compactación proporcionales en ventanas cortas
- no mostrar avisos de Anthropic con cuentas OpenAI-compatibles

### Documentación

- estado del roadmap tras la tanda de v0.6.0
- estado de las tandas 1 y 2 del bloque B y pendientes

### Tests

- tests de extremo a extremo del binario con backend falso y TUI en pseudo-terminal

## v0.5.0 (24/10/2026)

### Novedades

- versionado propio de FnHarness con script de release
- la pastilla de tareas cuenta también los monitors
- logo de terminal con prompt ƒ en la cabecera
- el pie muestra siempre el modo y el selector de shells y agentes
- cabecera compacta de FnHarness con logo propio
- marca FnHarness en la UI y cuenta qwen36 para el modelo local
- initial scaffold of fnharness

### Correcciones

- versiona src/cli, que la regla cli del .gitignore dejaba fuera

### Documentación

- roadmap con versionado, modelos de opencode y funcionalidades de Claude Code

