# Plan: recarga en caliente de servidores MCP en fnharness

Estado: investigación (24/10/2026). Base: fnharness (fork de Claude Code 2.1.87) frente a Claude Code 2.1.310.

## 1. Qué ofrece Claude Code actual (2.1.310)

Fuente: https://code.claude.com/docs/en/mcp.md y CHANGELOG.

- `notifications/tools|prompts|resources/list_changed`: en interactivo refresca sin reconectar; si el refresco falla, conserva la lista anterior. En modo v2 (protocolo 2026-07-28) mantiene un stream abierto y lo reabre con límites.
- Reconexión automática de servidores remotos (HTTP/SSE) caídos a mitad de sesión: hasta 5 intentos con backoff exponencial desde 1 s. Reintentos de primera conexión (3) para errores transitorios HTTP/SSE.
- Stdio: en interactivo, si el proceso muere queda `failed` y hay que pulsar Reconnect en `/mcp`; en `-p`/SDK se relanza en la siguiente llamada a una de sus tools.
- `/mcp`: panel con estado, Reconnect, Re-authenticate, Clear authentication, Disable/Enable. `/mcp reconnect all` desde v2.1.284.
- Caché de descubrimiento para remotos (v2.1.221, desactivada por defecto desde v2.1.238).
- `/reload-plugins`: conserva conexiones de plugins cuyo config no cambió. `/cd` (v2.1.246) conecta/desconecta los servidores de plugins del nuevo directorio.
- `headersHelper` se re-ejecuta en cada conexión y tras 401/403.
- La doc visible NO describe vigilancia automática de `.mcp.json`: Claude Code actual tampoco recarga el fichero solo; se hace con `/mcp` o sesión nueva. (Se leyó solo ~100k de 150k caracteres; el resto puede añadir algo.)
- Changelog (parte leída, hasta 2.1.296 visible): 2.1.299/2.1.307 arreglos de reconexión en headless; 2.1.300 informar a Claude de tools de un servidor que termina de conectar tras compactar.

## 2. Qué hay ya en fnharness (src/services/mcp)

La maquinaria de diff por hash YA existe; solo falta el disparador.

- `utils.ts`: `hashMcpConfig` (sha256 del config sin `scope`) y `excludeStalePluginClients`: un cliente es obsoleto si desapareció de la config con scope `dynamic`, o si su hash cambió (cualquier scope). Los servidores locales/proyecto/usuario que desaparecen NO se desconectan (por diseño, evitar cargas parciales).
- `useManageMCPConnections.ts`:
  - efecto "initializeServersAsPending" (~L772): recalcula `getClaudeCodeMcpConfigs`, desconecta obsoletos (limpia timer, `onclose = undefined`, `clearServerCache`) y los vuelve a poner `pending`.
  - efecto "loadAndConnect" (~L858): vuelve a conectar la config habilitada; `connectToServer` está memoizado, así que los ya conectados son cache hit.
  - Ambos dependen de `s.mcp.pluginReconnectKey` (AppState). Solo lo incrementa `refreshActivePlugins` (`utils/plugins/refresh.ts` L136, usado por `/reload-plugins` y `PluginInstallationManager`).
  - `onclose` (~L333): reconexión con backoff (5 intentos, 1 s a 30 s) SOLO para http/sse/ws; stdio y sdk se saltan explícitamente (L355).
  - Handlers `ToolListChanged`, `PromptListChanged`, `ResourceListChanged` (~L616) ya refrescan la caché y `updateServer`.
  - `reconnectMcpServer(name)` y `toggleMcpServer(name)` expuestos por contexto (`MCPConnectionManager.tsx`).
- `commands/mcp/mcp.tsx`: subcomandos `reconnect <nombre>`, `enable|disable <nombre|all>`; NO hay `reconnect all` (en 2.1.310 sí).
- Watchers: `utils/settings/changeDetector.ts` (chokidar, depth 0) vigila solo los ficheros de settings; `applySettingsChange` actualiza permisos/hooks/etc., no toca MCP. `.mcp.json` y `~/.fnharness/.claude.json` (mcpServers) NO se vigilan.
- Tools hacia el modelo: `query.ts` L1758 llama `options.refreshTools()` (REPL.tsx ~L2420 hace `assembleToolPool(state.mcp.tools)`) entre iteraciones del bucle, así que una tool nueva entra a mitad de turno sin reiniciar. Con tool search activo las tools MCP van diferidas.

## 3. Qué falta

| Hueco | Estado |
|---|---|
| (a) Vigilar `.mcp.json`, `~/.fnharness/.claude.json` y settings, y reconectar solo lo cambiado | Falta el watcher. El diff ya existe (hash) |
| (b) Comando `/reload-mcp` (o `/mcp reload [nombre]`, `/mcp reconnect all`) | No existe |
| (c) Autorreconexión de stdio con backoff | Excluida a propósito en L355 |
| (d) Refrescar tools en el prompt | Ya funciona vía `updateServer` + `refreshTools`; falta solo el aviso al modelo |
| Quitar un servidor de `.mcp.json` lo desconecta | No: solo se desconectan los `dynamic` |
| Binario actualizado en disco | Sin detección |

## 4. Diseño por fases

### Fase 1 - `/mcp reload` y `reconnect all` (S, ~80 líneas)
Ficheros: `src/commands/mcp/mcp.tsx`, `src/services/mcp/useManageMCPConnections.ts`, `src/services/mcp/MCPConnectionManager.tsx`.
- Exportar `reloadMcpConfig()` en el hook: limpia las cachés de config que haya (el parseo de `.mcp.json` no está memoizado; `getClaudeCodeMcpConfigs` sí lee plugins memoizados, usar `clearAllCaches` solo si hay plugins) y hace `setAppState(mcp.pluginReconnectKey + 1)`. Reutiliza todo el diff existente. Es el "bump" que ya hace `/reload-plugins`, sin recargar plugins.
- Cambiar `excludeStalePluginClients` con un flag `pruneRemoved` para que, en recarga explícita, también se desconecten los servidores de scope user/project/local que ya no estén en la config. El watcher y el comando lo pasan a true; el resto de rutas mantiene el comportamiento actual.
- `/mcp reconnect all`: iterar clientes `failed|needs-auth|pending` y llamar `reconnectMcpServer`.
- `/mcp reload [nombre]`: sin nombre, `reloadMcpConfig`; con nombre, `reconnectMcpServer` forzado (cierra el cliente aunque el hash no cambie, para el caso "binario actualizado").
- Resultado impreso: lista de añadidos / quitados / cambiados / sin cambios.

### Fase 2 - Vigilancia de ficheros (S/M, ~120 líneas)
Fichero nuevo `src/services/mcp/configWatcher.ts` (chokidar ya es dependencia, mismo patrón que `changeDetector.ts`): vigila `<cwd>/.mcp.json` (y los `.mcp.json` de directorios padre que ya recorre `getMcpConfigsByScope`), el `.claude.json` de usuario/proyecto y reutiliza `settingsChangeDetector.subscribe` para settings (managed policy, allowlists). Debounce 300 ms con `awaitWriteFinish`, ignorar escrituras propias (`markInternalWrite` ya existe para settings; `addMcpConfig`/`removeMcpConfig` escriben `.mcp.json`, marcarlas). Al disparar llama `reloadMcpConfig()`. Montar el watcher en `useManageMCPConnections` con un `useEffect` y cerrarlo al desmontar. Tras un cambio de proyecto (`/cd`) reiniciar rutas vigiladas. Flag `FNHARNESS_MCP_WATCH` (por defecto activo, `=0` lo apaga). JSON inválido a medio escribir: `parseMcpConfigFromFilePath` devuelve errores; en ese caso NO tocar conexiones (conservar el estado anterior) y mostrar aviso.
Opcional: aviso toast "MCP: +1 / -0 / ~1 servidores recargados".

### Fase 3 - Autorreconexión de stdio (M, ~100 líneas)
En `onclose` (L355) permitir `stdio` con política propia: solo si el proceso murió inesperadamente (no por disable/stale/reload), máx. 3-5 intentos, backoff 1 s a 30 s, y contador de "estable" (si vivió >60 s, reiniciar el contador) para evitar bucles de crash. Mostrar estado `pending` con `reconnectAttempt` (ya soportado en el tipo). Extraer la lógica de backoff a una función pura `nextBackoffMs(attempt)` con test.
Opcional: detectar binario cambiado (`fs.stat` de `command` por mtime en el watcher) y ofrecer reload del servidor concreto.

### Fase 4 - Avisar al modelo (S)
Al cambiar el conjunto de tools de un servidor, inyectar un mensaje de sistema/attachment efímero ("el servidor X ahora expone: ...") en la siguiente iteración, como hace 2.1.300. Con tool search no hay problema de caché; sin él, cambiar la lista de tools invalida la caché de prompt (prefijo tools), asumir ese coste una vez por cambio.

## 5. Riesgos

- Tools que desaparecen a mitad de turno: `refreshTools` entre iteraciones puede quitar una tool que el modelo ya pidió en un `tool_use` pendiente; la llamada devolvería "No such tool". Mitigación: aplazar la desconexión si hay un `tool_use` en curso para ese servidor (cola `pendingDisconnect` hasta fin de turno) o devolver un `tool_result` de error claro.
- Caché de prompt: añadir/quitar tools cambia el bloque `tools`, rompe el prefijo cacheado (coste de tokens una vez). Agrupar recargas con el debounce y no recargar durante el streaming de un turno.
- OAuth: un servidor remoto cambiado (url distinta) pierde el token asociado; no borrar credenciales al desconectar, y en recarga marcar `needs-auth` en vez de abrir el navegador automáticamente. `headersHelper` se re-ejecuta solo al reconectar (ya soportado).
- Bucles de crash en stdio y tormenta de eventos del watcher (editores que escriben por rename): debounce + límite de reintentos.
- Escrituras propias (`/mcp add`, `claude mcp add`): evitar doble recarga.
- Recarga parcial con JSON roto: no desconectar nada.
- Procesos huérfanos: al reemplazar un stdio, esperar el cierre (señales ya manejadas en client.ts ~L1428) antes de lanzar el nuevo.

## 6. Tamaño y orden

1. Fase 1 (`/mcp reload`, `reconnect all`): 0,5 día. Valor inmediato y es la base de todo.
2. Fase 2 (watcher): 0,5-1 día.
3. Fase 3 (stdio con backoff): 0,5 día.
4. Fase 4 (aviso al modelo y mitigación mid-turn): 0,5 día.
Pruebas: unitarias de `hashMcpConfig`/diff y `nextBackoffMs`; e2e en `tests/e2e` con `CLAUDE_CONFIG_DIR` temporal (`makeSandbox` de `harness.ts`) y un MCP stdio trivial que se puede matar y cuyo `.mcp.json` se edita.

No se escribió prototipo de código; solo este plan.
