/**
 * Estado inicial de contexto de una sesión: el perfil con el que arrancó (si hay)
 * y el scope derivado de él; sin perfil, el scope recordado de la cuenta.
 */

import type { ContextProfile } from './contextProfile.js'
import { parseStoredProfile } from './contextProfile.js'
import { resolveInitialContextProfile } from './contextProfileStore.js'
import { toScope } from './perfil.js'
import { getBootPerfil, type ActivePerfil } from './perfilStore.js'

export function initialPerfilState(env: Record<string, string | undefined> = process.env): {
  contextProfile: ContextProfile
  perfil?: ActivePerfil
} {
  const boot = getBootPerfil()
  if (!boot) return { contextProfile: resolveInitialContextProfile(env) }
  // FNHARNESS_CONTEXT_PROFILE es un forzado explícito del scope: gana, y el perfil queda "modificado".
  const forced = parseStoredProfile(env.FNHARNESS_CONTEXT_PROFILE)
  if (forced) return { contextProfile: forced, perfil: { ...boot, modified: true } }
  return { contextProfile: toScope(boot.def), perfil: boot }
}
