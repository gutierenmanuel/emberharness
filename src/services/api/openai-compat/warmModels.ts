import { activeTarget, listAccountModels } from './accountModels.js'

/** Queries the active account's server once so /model can show what it really has. Never throws. */
export async function warmActiveAccountModels(): Promise<void> {
  const target = activeTarget()
  if (!target) return
  try {
    await listAccountModels(target)
  } catch {}
}
