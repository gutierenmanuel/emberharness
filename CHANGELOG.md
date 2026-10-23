# Changelog de FnHarness

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

