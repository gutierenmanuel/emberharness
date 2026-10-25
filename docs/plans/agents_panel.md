# Panel de subagentes bajo el prompt

Rama `quick/agents-panel`, 24/10/2026. Objetivo: que los subagentes (Agent tool, en primer plano y en
segundo plano) se vean directamente debajo del prompt, como en Claude Code 2.1.310, y se puedan
seleccionar y abrir.

## Qué hace Claude Code 2.1.310 (observado en un pseudo-terminal, `claude --model haiku`)

Con dos agentes en segundo plano:

```
● 2 background agents launched (↓ to manage)
   ├ Contar .ts en src/
   └ Contar .ts en src/utils
...
✻ Waiting for 2 background agents to finish
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ● main
  ◯ Explore  Contar .ts en src/                                        7s · ↓ 16.9k tokens
  ◯ Explore  Contar .ts en src/utils                                   7s · ↓ 16.8k tokens
```

- Una fila por agente bajo el prompt, precedida de la línea `● main`. Formato: bullet, tipo de agente
  (`Explore`), descripción, y a la derecha tiempo y tokens (`↓` mientras recibe).
- `↓` desde el prompt entra en el panel; la selección empieza en `main` y baja fila a fila (`↑/↓ to select`).
  La fila seleccionada lleva `❯` y el pie muestra `Enter to view · x to stop`.
- `Enter` abre el transcript del agente en la misma pantalla: el borde del prompt lleva el nombre
  del agente, el input pasa a `Message @Explore…` (steering) y la fila abierta pasa a `●`; `main` vuelve
  a `◯` y `Enter` sobre `main` regresa. `Esc` deselecciona la fila (no interrumpe).
- Al terminar un agente desaparece de la lista y deja `Agent "…" finished · 11s` en el transcript.
- Pie normal: `/tasks to see subagents`; `Ctrl+X Ctrl+K` para parar todos los agentes en segundo plano.

## Qué tenía ya fnharness (base 2.1.87)

El código completo del panel estaba en el árbol pero compilado fuera (`"external" === 'ant'`):
`CoordinatorTaskPanel` y `getVisibleAgentTasks` (`src/components/CoordinatorAgentStatus.tsx`), el
índice `coordinatorTaskIndex` en AppState, la navegación `footer:up/down/openSelected/close` en
`PromptInput.tsx`, `enterTeammateView` / `exitTeammateView` y la tarea `local_agent` con `evictAfter`.
`useCoordinatorTaskCount` estaba reducido a `return 0` por el compilador. El pie
`N shells · N monitors · N agents` (`pillLabel.ts`, `BackgroundTaskStatus.tsx`) y el diálogo
`BackgroundTasksDialog` funcionaban como lista aparte.

## Qué se hizo

- Constante `AGENT_PANEL_ENABLED = true` en `LocalAgentTask.tsx` que sustituye a la guarda interna en
  `PromptInputFooter.tsx` (render del panel), `PromptInputFooterLeftSide.tsx` (aviso `↓ to manage`) y
  `PromptInput.tsx` (navegación ↑/↓ dentro del panel y selección inicial en `main`).
- `useCoordinatorTaskCount` calcula las filas seleccionables (`main` + agentes).
- Fila reescrita a mano (el original eran celdas de React Compiler) con layout puro en
  `src/components/agentPanelRow.ts` (con tests): tipo de agente, descripción truncada, tiempo y tokens
  alineados a la derecha, `❯` al seleccionar, `●` si es la vista abierta, pista `Enter to view · x to stop`.
- Se mantiene el pie `N shells · N monitors · N agents` (los agentes siguen contando en la pastilla).
- `scripts/mock_openai.ts`: regla `AGENT_DEMO` (dos `Agent` con `run_in_background`; los subagentes
  responden tras `MOCK_SUB_DELAY_MS`, 12 s por defecto). Test e2e `tests/e2e/agentsPanel.e2e.test.ts`.

## Salida de fnharness (mock, 120 columnas)

```
❯ AGENT_DEMO
● Agent(count src)
  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)
● Agent(count utils)
  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵ default mode (shift+tab to cycle) · 2 local agents · ctrl+x ctrl+k to stop agents · ↓ to manage
  ● main
  ◯ general-purpose  count src                                                                  3s
❯ ◯ general-purpose  count utils                                        8s · Enter to view · x to stop
```

Enter abre el transcript (`── count utils ──` en el borde, fila `●`), `Esc` vuelve.

## Paridad con 2.1.310 (rama `quick/panel-parity`, 25/10/2026)

- Los agentes terminados desaparecen del panel a los 5 s (`PANEL_GRACE_MS` en `utils/task/framework.ts` y
  `state/teammateViewHelpers.ts`, antes 30 s). La notificación del transcript se muestra como
  `Agent "desc" finished · 11s` (`components/messages/agentNotificationSummary.ts`, con tests); el modelo sigue
  recibiendo el texto `completed` original. Fallos y paradas no cambian.
- El mensaje de lanzamiento de varios agentes en una misma respuesta ya agrupaba (`renderGroupedAgentToolUse`);
  el árbol usa ahora `├ ` / `└ ` como Claude Code actual (antes `├─`). Solo se agrupa si los agentes llegan en
  la misma respuesta del modelo (mismo `message.id`): lanzados en turnos distintos salen como llamadas sueltas.
  La regla `AGENT_PAR` del mock emite dos `Explore` en una sola respuesta.
- Hint `Message @<tipo>…` en el input al abrir un agente local (antes solo existía para teammates). Escribir ahí
  ya enviaba el mensaje al agente (`onAgentSubmit`: `queuePendingMessage` si corre, `resumeAgentBackground` si
  terminó), igual que SendMessage.
- Agente integrado `Explore` (y `Plan`) siempre activo: `areExplorePlanAgentsEnabled()` devuelve `true` sin la
  feature flag, que solo estaba en el set `dev-full`. Es solo lectura por `disallowedTools` (Agent, ExitPlanMode,
  Edit, Write, NotebookEdit) y por prompt; Bash no está restringido por permisos, solo por el prompt.
- Tests: unit de `agentNotificationSummary`; e2e `agentsPanel.e2e.test.ts` cubre árbol, tipo `Explore`, hint,
  aviso `finished` y desaparición de las filas.

## Diferencias que quedan

- El Bash de `Explore` no tiene lista blanca de comandos: la restricción de solo lectura es del prompt.
- Los agentes lanzados en turnos separados no se agrupan en un solo mensaje (igual que upstream).
- El pie conserva el contador de agentes además del panel (decisión: se pidió mantenerlo).
- Los tokens del panel dependen de que el backend informe `usage`; con el mock quedan en blanco.
