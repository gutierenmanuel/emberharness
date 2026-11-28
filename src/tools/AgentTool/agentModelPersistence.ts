/**
 * Keeps a subagent on its account across resumes.
 *
 * An agent launched with `model: "cuenta:modelo"` resolves to a canonical
 * `cuenta:modelo` (getAgentModel). That string is persisted in the agent's
 * sidecar metadata, and a resume (SendMessage to a stopped agent, or the REPL
 * continuing one) reuses it, so the resumed agent keeps answering from the
 * same account instead of falling back to the session's model.
 *
 * Agents without an account prefix persist nothing: their resume keeps the
 * previous behaviour (inherit / frontmatter model), and old metadata files
 * without the field behave exactly as before.
 */

import { tryRouteForModel, type RouteDeps } from '../../services/api/accountRouting.js'

/** The model to store in the agent metadata: only a routed `cuenta:modelo`. */
export function persistableAgentModel(
  resolvedModel: string | undefined,
  deps: RouteDeps = {},
): string | undefined {
  return resolvedModel && tryRouteForModel(resolvedModel, deps) ? resolvedModel : undefined
}

/**
 * The model a resumed agent must run on: the one persisted in its metadata,
 * else the one recorded on its in-memory task when it was routed, else
 * undefined (resolve as before).
 */
export function resumeAgentModel(
  metaModel: string | undefined,
  taskModel: string | undefined,
  deps: RouteDeps = {},
): string | undefined {
  if (metaModel) return metaModel
  return persistableAgentModel(taskModel, deps)
}
