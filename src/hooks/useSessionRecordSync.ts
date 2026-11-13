import { useEffect } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { patchSessionRecord } from '../utils/concurrentSessions.js'
import { buildRecordOrigin } from '../utils/sessionRecord.js'

/** Cuenta activa: la que fija /account (FNHARNESS_ACCOUNT) o, al arrancar, la del flag. */
function currentAccount(): string | undefined {
  return process.env.FNHARNESS_ACCOUNT ?? process.env.CLAUDE_MULTIMODEL_ACCOUNT
}

/**
 * Publica en el registro de la sesión (`sessions/<pid>.json`) el arnés, el
 * origen (kitty/tmux/Element), la cuenta y el modelo activos, para que
 * `/sesiones` y el selector de ← los muestren. Se ejecuta al montar y cuando
 * cambia la cuenta o el modelo (un cambio de cuenta con `/account` cambia
 * también el modelo o, al menos, vuelve a renderizar). El sessionId inicial
 * se escribe también aquí; los cambios posteriores (/clear, --resume) los
 * mantiene `registerSession`. Es best-effort: sin registro no hace nada.
 */
export function useSessionRecordSync(model: string): void {
  const account = currentAccount()
  useEffect(() => {
    void patchSessionRecord({
      harness: 'fnharness',
      sessionId: getSessionId(),
      origin: buildRecordOrigin(process.env),
      account,
      model,
    })
  }, [account, model])
}
