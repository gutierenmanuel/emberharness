/**
 * The model of the agent running in the current async context.
 *
 * A subagent launched with `model: "cuenta:modelo"` runs its main loop on that
 * account because its mainLoopModel keeps the prefix. Side calls made from
 * inside it (WebFetch's small-fast model, token counting, prompt hooks,
 * memory prefetch) do not see that model: they read session-wide settings.
 * This scope carries the agent's resolved model through every async
 * continuation of the agent, so those side calls can be served by the
 * agent's account instead of the session's (accountRouting.agentSideModel).
 *
 * Outside any agent the store is empty and everything answers for the session.
 */

import { AsyncLocalStorage } from 'async_hooks'

const agentModelStore = new AsyncLocalStorage<string>()

/** Resolved model of the agent in force (`cuenta:modelo` when routed), or undefined in the main session. */
export function getAgentScopeModel(): string | undefined {
  return agentModelStore.getStore()
}

/** Runs `fn` (sync, or async until its promise settles) as the agent whose model is `model`. */
export function runWithAgentModel<T>(model: string, fn: () => T): T {
  return agentModelStore.run(model, fn)
}

/**
 * Wraps an async generator so every resumption of its body runs with
 * `model` as the agent model. AsyncLocalStorage does not follow a generator
 * across `next()` calls made from outside, so the wrapper re-enters the store
 * on each step; promises created inside the body keep it on their own.
 */
export function withAgentModelGenerator<T, R>(
  model: string,
  gen: AsyncGenerator<T, R>,
): AsyncGenerator<T, R> {
  const step = (fn: () => Promise<IteratorResult<T, R>>) =>
    agentModelStore.run(model, fn)
  const wrapped: AsyncGenerator<T, R> = {
    next: (...args) => step(() => gen.next(...args)),
    return: value => step(() => gen.return(value)),
    throw: err => step(() => gen.throw(err)),
    [Symbol.asyncIterator]() {
      return wrapped
    },
  } as AsyncGenerator<T, R>
  return wrapped
}
