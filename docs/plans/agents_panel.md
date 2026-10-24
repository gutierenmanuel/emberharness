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

## Diferencias que quedan

- Los agentes terminados siguen unos segundos en la lista (`evictAfter`) en vez de desaparecer al instante.
- Falta el árbol `├ └` con las descripciones en el mensaje de lanzamiento y la línea
  `Agent "…" finished · 11s`; el input del agente abierto no muestra el marcador `Message @tipo…`.
- No existe el agente integrado `Explore` (solo `general-purpose`, `statusline-setup`, `claude-code-guide`).
- El pie conserva el contador de agentes además del panel (decisión: se pidió mantenerlo).
- Los tokens del panel dependen de que el backend informe `usage`; con el mock quedan en blanco.
