import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { launchBg, launchSummary } from '../../cli/bg.js'
import { backgroundPassthrough } from '../../cli/bgCore.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * `/background <prompt>`: starts a detached headless session that forks the
 * current conversation and works on <prompt>. The TUI stays usable; follow it
 * with `fnharness logs <id> -f` from another terminal.
 */
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const prompt = args.trim()
  if (!prompt) {
    onDone('Uso: /background <prompt> — lanza una sesión en segundo plano que continúa esta conversación.', {
      display: 'system',
    })
    return null
  }
  try {
    const mode = context.getAppState().toolPermissionContext.mode
    const meta = launchBg({
      prompt,
      passthrough: backgroundPassthrough(mode),
      cwd: getOriginalCwd(),
      // An empty conversation has no transcript to fork yet.
      forkFrom: context.messages.some(m => m.type === 'assistant') ? getSessionId() : undefined,
    })
    onDone(launchSummary(meta), { display: 'system' })
  } catch (e) {
    onDone(`No se pudo lanzar la sesión: ${e instanceof Error ? e.message : String(e)}`, {
      display: 'system',
    })
  }
  return null
}
