import { accountModelsSync, activeTarget, describeModel } from '../../services/api/openai-compat/accountModels.js'
import { getMultimodelProfile } from '../../services/api/openai-compat/profiles.js'

export type MultimodelOption = { value: string; label: string; description: string }

/**
 * /model options for the active non-Claude account: the current model first,
 * then the catalog models newest first, then models only the server reports.
 * Null when the Claude account is active (the stock list applies).
 */
export function getMultimodelModelOptions(current?: string | null): MultimodelOption[] | null {
  const profile = getMultimodelProfile()
  const target = activeTarget()
  if (!profile || !target) return null
  const models = accountModelsSync(target)
  const options: MultimodelOption[] = models.map(m => ({
    value: m.id,
    label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id,
    description: describeModel(m),
  }))
  const cur = current || profile.model
  const i = options.findIndex(o => o.value === cur)
  const head = i >= 0 ? options.splice(i, 1)[0]! : { value: cur, label: cur, description: 'Modelo actual' }
  return [head, ...options]
}
