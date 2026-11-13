/**
 * Aplicar un perfil a la sesión viva: lo que además de cambiar el estado hay que
 * invalidar para que el siguiente turno lo note.
 */

import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { getUserContext } from '../context.js'
import type { AppState } from '../state/AppStateStore.js'
import { toScope, type Perfil } from './perfil.js'
import { applyPerfilEnv } from './perfilStore.js'

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Hace `p` el perfil de la sesión: scope (herramientas, MCP, skills), entorno de
 * CLAUDE.md, memoria y hooks, y estado `perfil` (que REPL lee para el system prompt).
 * No usa applyContextProfile: ese guarda el scope en la cuenta, y un perfil no es
 * una preferencia de la cuenta. Se aplica desde el siguiente turno.
 */
export function applyPerfilToSession(setAppState: SetAppState, p: Perfil): void {
  applyPerfilEnv(p)
  setAppState(prev => ({
    ...prev,
    contextProfile: toScope(p),
    perfil: { name: p.name, def: p, modified: false },
  }))
  // CLAUDE.md va en el contexto de usuario memoizado y la memoria en secciones cacheadas.
  clearSystemPromptSections()
  getUserContext.cache.clear?.()
}
