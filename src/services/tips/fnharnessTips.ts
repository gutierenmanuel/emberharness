import type { Tip } from './types.js'

/**
 * Tips propios de fnharness. Sustituyen a los del Claude Code original (que
 * empujan planes de pago, apps de escritorio/móvil/Slack y plugins de terceros)
 * por consejos del flujo de trabajo del ecosistema fn_registry. Los tips
 * originales siguen en tipRegistry.ts (externalTips) para poder fusionar upstream,
 * pero getRelevantTips ya no los usa.
 *
 * Añadir un tip: una línea más aquí. cooldownSessions es el mínimo de sesiones
 * entre dos apariciones del mismo tip.
 */
const fnharnessTipTexts: Array<[id: string, content: string]> = [
  [
    'fn-plan-mode',
    'Plan Mode para tareas complejas: shift+tab dos veces, y lanza el agente planner antes de tocar código',
  ],
  [
    'fn-steer-realtime',
    'Enter mientras Claude trabaja encola o dirige: puedes corregirle el rumbo en tiempo real',
  ],
  [
    'fn-double-esc',
    'Doble Esc rebobina conversación y/o código a un punto anterior',
  ],
  [
    'fn-resume',
    'claude --continue o --resume retoman una conversación; /rename la nombra para encontrarla luego',
  ],
  [
    'fn-worktree',
    '/worktree new <slug> abre un árbol propio; con varias sesiones en el mismo árbol evitas pisarte',
  ],
  [
    'fn-color-rename',
    '/color y /rename distinguen de un vistazo varias sesiones abiertas',
  ],
  [
    'fn-registry-first',
    'Antes de escribir código, fn_search: si ya existe una función en el registry, impórtala en vez de reescribirla',
  ],
  [
    'fn-buscar-skill',
    'Si nada cargado encaja con lo que pides, /buscar-skill busca en el catálogo de skills y comandos bajo demanda',
  ],
  [
    'fn-subagents',
    'Para tareas grandes, pide subagentes en paralelo y elige el modelo según la tarea (haiku, sonnet u opus)',
  ],
  [
    'fn-loop',
    '/loop 5m <prompt> repite un prompt en intervalo: vigilar builds, PRs o procesos largos',
  ],
  [
    'fn-long-processes',
    'Procesos largos: lánzalos en segundo plano con log y vigílalos con Monitor, sin sleep a ciegas',
  ],
  [
    'fn-memory-permissions',
    '/memory muestra y gestiona la memoria persistente; /permissions pre-aprueba o deniega tools',
  ],
  [
    'fn-agents',
    '/agents crea y edita subagentes; --agent <nombre> arranca una sesión directamente con uno',
  ],
  [
    'fn-paste-images',
    'ctrl+v pega imágenes del portapapeles; también puedes arrastrarlas a la terminal',
  ],
]

export const fnharnessTips: Tip[] = fnharnessTipTexts.map(([id, content]) => ({
  id,
  content: async () => content,
  cooldownSessions: 3,
  isRelevant: async () => true,
}))
