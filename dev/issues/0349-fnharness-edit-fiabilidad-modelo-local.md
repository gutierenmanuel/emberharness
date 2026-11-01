---
id: "0349"
title: "[fnharness] El modelo local no llama a Edit tras leer el archivo (9/18 en la prueba real)"
status: pendiente
type: bug
domain:
  - apps-fnharness
scope: app-scoped
priority: media
depends: []
blocks: []
related: []
created: 2026-10-25
updated: "2026-10-25"
tags: [fnharness, llm-local, qwen36, tool-calling, edit]
gitea_repo: dataforge/fnharness
gitea_issue: ""
moved_from: fn_registry#0349
---

# 0349 — El modelo local no llama a Edit tras leer el archivo

## Contexto

El 25/10/2026 se fusionó en `master` de fnharness la rama `quick/prompt-diet`. Esa rama recorta el prompt en
las cuentas locales (de 10,8k a 2,8k tokens en una sesión nueva en fn_registry, y el primer token de ~30 s a
12 s en frío o 1,4 s con caché), arregla Grep y Glob en el binario compilado (antes fallaban con
`ENOENT .../vendor/ripgrep/x64-linux/rg`), permite Edit sin Read previo solo en cuentas locales y arranca las
cuentas locales con `--setting-sources user` (se desactiva con `FNHARNESS_LOCAL_LEAN=0`).

La prueba real de editar un archivo (`reports/llm_speed_bench/prompt_diet/bench_quality.py`, tarea `edit`:
«En config.py cambia el valor de TIMEOUT de 5 a 30 usando Edit») dio 9/18 con la versión fusionada (tandas de
4/6, 3/6 y 2/6). El prototipo previo había dado 6/6 y 5/6 con muestras igual de pequeñas.

## Síntoma

En todos los fallos el patrón es el mismo: el modelo hace Grep o Glob, después Read, ve `TIMEOUT = 5` y
responde «ya vale 5» sin llamar a Edit. Las tools funcionan, ya no hay ENOENT. El banco recrea el archivo en
cada ejecución, así que no es un estado sucio.

Quitar el recordatorio de malware del resultado de Read no ayudó (2/6) y se revirtió.

## Hipótesis por comprobar

1. Ruido de muestreo a `--temp 0.5` con muestras de 6: la diferencia con el prototipo podría no ser real.
2. El modo ligero (`--setting-sources user`) influye: medir la misma tarea con `FNHARNESS_LOCAL_LEAN=0`.
3. La especulación del servidor (draft-mtp + ngram-mod en `llm-qwen36`), aunque en teoría no cambia la
   distribución, medir con y sin ella.
4. Una instrucción corta en el system prompt del perfil local («tras leer, aplica el cambio pedido con Edit»).

## Definition of Done

- Al menos 24 ejecuciones por variante para separar ruido de efecto.
- Una configuración por defecto de las cuentas locales que dé ≥ 5/6 en la tarea `edit` sin perder el recorte
  de tokens, o la conclusión documentada de que el límite está en el modelo.
- Resultados en `reports/llm_speed_bench/prompt_diet/README.md`.
