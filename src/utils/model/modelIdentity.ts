/**
 * Identidad de modelo: única fuente de verdad de lo que el prompt de sistema y
 * el trailer de commit afirman sobre el modelo en uso (nombre comercial, corte
 * de conocimiento, familia, modelos Claude más recientes, modo rápido).
 *
 * Es una función pura sin imports para poder testearla sin arrancar el
 * harness. Para añadir un modelo nuevo basta una línea en `CLAUDE_MODELS`; los
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
  /** Nombre para el trailer `Co-Authored-By`. */
  coAuthorName: string
  /** Correo para el trailer `Co-Authored-By`. */
  coAuthorEmail: string
}

type ClaudeModelEntry = {
  /** Prefijo canónico sin fecha ni sufijos, p. ej. `claude-sonnet-5-5`. */
  id: string
  tier: ClaudeTier
  /** Versión legible, p. ej. `5.5`. */
  version: string
  knowledgeCutoff?: string
  supportsFastMode?: boolean
  /** ID completo que se muestra al modelo como referencia de API. */
  apiId: string
}

// @[MODEL LAUNCH]: añadir aquí cada modelo Claude nuevo (una línea). El orden
// no importa: "el más reciente" de cada tier es el de mayor versión.
const CLAUDE_MODELS: readonly ClaudeModelEntry[] = [
  {
    id: 'claude-opus-4-6',
    tier: 'opus',
    version: '4.6',
    knowledgeCutoff: 'May 2025',
    supportsFastMode: true,
    apiId: 'claude-opus-4-6',
  },
  {
    id: 'claude-opus-4-5',
    tier: 'opus',
    version: '4.5',
    knowledgeCutoff: 'May 2025',
    apiId: 'claude-opus-4-5',
  },
  {
    id: 'claude-sonnet-5-5',
    tier: 'sonnet',
    version: '5.5',
    apiId: 'claude-sonnet-5-5',
  },
  {
    id: 'claude-sonnet-4-6',
    tier: 'sonnet',
    version: '4.6',
    knowledgeCutoff: 'August 2025',
    apiId: 'claude-sonnet-4-6',
  },
  {
    id: 'claude-sonnet-4-5',
    tier: 'sonnet',
    version: '4.5',
    knowledgeCutoff: 'January 2025',
    apiId: 'claude-sonnet-4-5',
  },
  {
    id: 'claude-haiku-4-5',
    tier: 'haiku',
    version: '4.5',
    knowledgeCutoff: 'February 2025',
    apiId: 'claude-haiku-4-5-20251001',
  },
]

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
      const known = CLAUDE_MODELS.find(entry => entry.id === canonical)
      const marketingName = `${capitalize(tier)} ${version}`
      return {
        family,
        marketingName,
        knowledgeCutoff: known?.knowledgeCutoff,
        tier,
        supportsFastMode: known?.supportsFastMode ?? false,
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
  for (const entry of CLAUDE_MODELS) {
    const current = result[entry.tier]
    if (!current || compareVersions(entry.version, current.version) > 0) {
      result[entry.tier] = {
        marketingName: `${capitalize(entry.tier)} ${entry.version}`,
        apiId: entry.apiId,
        version: entry.version,
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
