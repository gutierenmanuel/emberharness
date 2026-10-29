/**
 * Identidad de modelo: única fuente de verdad de lo que el prompt de sistema y
 * el trailer de commit afirman sobre el modelo en uso (nombre comercial, corte
 * de conocimiento, familia, modelos Claude más recientes, modo rápido).
 *
 * Los modelos conocidos salen de `claude-models.json` (defaults del repo más el
 * del usuario, con hot reload; ver services/config/claudeModels.ts), sin
 * dependencias del harness para poder testearla. Para añadir un modelo nuevo
 * basta una entrada ahí, sin recompilar; los
 * Claude con formato `claude-<tier>-<major>-<minor>` se reconocen solos aunque
 * no estén en la tabla, y cualquier modelo desconocido recibe una identidad
 * conservadora (solo su ID, sin versión ni corte inventados).
 */

export type ModelFamily = 'claude' | 'openai' | 'other'

export type ClaudeTier = 'opus' | 'sonnet' | 'haiku'

export type ModelIdentity = {
  family: ModelFamily
  /** Nombre comercial corto ("Sonnet 5.5"); undefined si no se conoce. */
  marketingName?: string
  /** Corte de conocimiento ("August 2025"); undefined si no se conoce. */
  knowledgeCutoff?: string
  /** Tier Claude, si procede. */
  tier?: ClaudeTier
  /** El modo rápido de Claude Code usa este modelo. */
  supportsFastMode: boolean
  /** Ventana de contexto nativa, si el modelo la trae sin opt-in `[1m]`. */
  contextWindow?: number
  /** Nombre para el trailer `Co-Authored-By`. */
  coAuthorName: string
  /** Correo para el trailer `Co-Authored-By`. */
  coAuthorEmail: string
}

import { claudeIdentityModels } from '../../services/config/claudeModels.js'

const CLAUDE_ID_RE = /claude-(opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/

const CLAUDE_EMAIL = 'noreply@anthropic.com'
const LOCAL_EMAIL = 'noreply@fnharness.local'

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function parseVersion(version: string): number[] {
  return version.split('.').map(Number)
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function detectFamily(lowerId: string): ModelFamily {
  if (lowerId.includes('claude')) return 'claude'
  if (lowerId.includes('gpt-') || lowerId.includes('codex')) return 'openai'
  return 'other'
}

/**
 * Identidad del modelo a partir de su ID (con o sin fecha, `[1m]` o prefijo de
 * proveedor). Nunca lanza.
 */
export function getModelIdentity(modelId: string): ModelIdentity {
  const lowerId = modelId.toLowerCase().replace(/\[(1|2)m\]/g, '')
  const family = detectFamily(lowerId)

  if (family === 'claude') {
    const match = CLAUDE_ID_RE.exec(lowerId)
    if (match) {
      const tier = match[1] as ClaudeTier
      const version = match[3] ? `${match[2]}.${match[3]}` : `${match[2]}`
      const canonical = `claude-${tier}-${match[2]}${match[3] ? `-${match[3]}` : ''}`
      const known = claudeIdentityModels().find(entry => entry.id === canonical)
      const marketingName = `${capitalize(tier)} ${version}`
      return {
        family,
        marketingName,
        knowledgeCutoff: known?.knowledgeCutoff,
        tier,
        supportsFastMode: known?.supportsFastMode ?? false,
        contextWindow: known?.contextWindow,
        coAuthorName: `Claude ${marketingName}`,
        coAuthorEmail: CLAUDE_EMAIL,
      }
    }
    return {
      family,
      supportsFastMode: false,
      coAuthorName: `Claude (${modelId})`,
      coAuthorEmail: CLAUDE_EMAIL,
    }
  }

  return {
    family,
    supportsFastMode: false,
    coAuthorName: modelId,
    coAuthorEmail: LOCAL_EMAIL,
  }
}

/** Modelo más reciente conocido de cada tier Claude, por versión. */
export function getLatestClaudeModels(): Record<
  ClaudeTier,
  { marketingName: string; apiId: string }
> {
  const result = {} as Record<
    ClaudeTier,
    { marketingName: string; apiId: string; version: string }
  >
  for (const entry of claudeIdentityModels()) {
    const tier = entry.tier!
    const version = entry.version!
    // "5.1 Fable" is its own line of models, not the newest Opus.
    if (!/^\d+(\.\d+)*$/.test(version)) continue
    const current = result[tier]
    if (!current || compareVersions(version, current.version) > 0) {
      result[tier] = {
        marketingName: `${capitalize(tier)} ${version}`,
        apiId: entry.apiId!,
        version,
      }
    }
  }
  return result
}

/** Línea de prompt con los modelos Claude más recientes (solo familia Claude). */
export function describeLatestClaudeModels(): string {
  const latest = getLatestClaudeModels()
  const parts = (['opus', 'sonnet', 'haiku'] as const)
    .filter(tier => latest[tier])
    .map(
      tier => `${latest[tier].marketingName}: '${latest[tier].apiId}'`,
    )
  return `Latest known Claude models — ${parts.join(', ')}. When building AI applications, default to the latest and most capable Claude models.`
}
