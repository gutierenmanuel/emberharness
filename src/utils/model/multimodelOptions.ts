import { accountModelsSync, activeTarget, describeModel } from '../../services/api/openai-compat/accountModels.js'
import { getMultimodelProfile } from '../../services/api/openai-compat/profiles.js'

export type MultimodelOption = { value: string; label: string; description: string }

/**
 * /model options for the active non-Claude account: the current model first,
 * then the catalog models newest first, then models only the server reports.
 * Null when the Claude account is active (the stock list applies).
 */
/**
 * Pure: local servers (llama.cpp, Ollama's llama-server) report the loaded
 * file path as the model id; show its basename without the extension.
 */
export function displayModelId(id: string): string {
  if (!id.includes('/')) return id
  return id.slice(id.lastIndexOf('/') + 1).replace(/\.gguf$/i, '')
}

export function getMultimodelModelOptions(current?: string | null): MultimodelOption[] | null {
  const profile = getMultimodelProfile()
  const target = activeTarget()
  if (!profile || !target) return null
  const cur = current || profile.model
  const models = accountModelsSync(target).filter(
    // A server path naming the configured model is the same model: keep one entry.
    m => m.id === cur || displayModelId(m.id) !== cur,
  )
  const options: MultimodelOption[] = models.map(m => {
    const shown = displayModelId(m.id)
    return {
      value: m.id,
      label: m.name && m.name !== m.id ? `${m.name} (${shown})` : shown,
      description: shown !== m.id ? `fichero local: ${m.id}` : describeModel(m),
    }
  })
  const i = options.findIndex(o => o.value === cur)
  const head = i >= 0 ? options.splice(i, 1)[0]! : { value: cur, label: cur, description: 'Modelo actual' }
  return [head, ...options]
}
