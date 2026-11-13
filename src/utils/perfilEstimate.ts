/**
 * Coste aproximado en tokens de un perfil: lo que ya cuenta el scope (sistema +
 * herramientas + skills, contextProfileEstimate.ts) corregido con lo que el scope no
 * ve, el texto del system prompt del perfil y el CLAUDE.md. Es una estimación local
 * (caracteres / 4): no llama a ninguna API ni toca la conversación en curso.
 */

import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { AppState } from '../state/AppStateStore.js'
import { filterInjectedMemoryFiles, getClaudeMds, getMemoryFiles } from './claudemd.js'
import { estimateContextProfile } from './contextProfileEstimate.js'
import { toScope, type Perfil } from './perfil.js'

export type PerfilEstimate = {
  total: number
  system: number
  tools: number
  skills: number
  claudeMd: number
  toolCount: number
}

let claudeMdTokens: Promise<number> | undefined

/** Tokens del CLAUDE.md del directorio de trabajo; se calcula una vez por sesión. */
function claudeMdSize(): Promise<number> {
  claudeMdTokens ??= (async () => {
    try {
      const text = getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
      return text ? roughTokenCountEstimation(text) : 0
    } catch {
      return 0
    }
  })()
  return claudeMdTokens
}

/** Pura: combina la estimación del scope con el texto del prompt y el CLAUDE.md. */
export function combinePerfilEstimate(
  base: { system: number; tools: number; skills: number; toolCount: number },
  perfil: Pick<Perfil, 'systemPrompt' | 'context'>,
  claudeMd: number,
): PerfilEstimate {
  const text = perfil.systemPrompt.text ?? ''
  const textTokens = text ? roughTokenCountEstimation(text) : 0
  const system =
    perfil.systemPrompt.mode === 'replace' ? textTokens : base.system + (perfil.systemPrompt.mode === 'append' ? textTokens : 0)
  const md = perfil.context.claudeMd && !perfil.context.bare ? claudeMd : 0
  return {
    total: system + base.tools + base.skills + md,
    system,
    tools: base.tools,
    skills: base.skills,
    claudeMd: md,
    toolCount: base.toolCount,
  }
}

export async function estimatePerfil(state: AppState, p: Perfil): Promise<PerfilEstimate> {
  const [base, md] = await Promise.all([estimateContextProfile(state, toScope(p)), claudeMdSize()])
  return combinePerfilEstimate(base, p, md)
}
