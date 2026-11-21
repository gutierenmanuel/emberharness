import { useEffect } from 'react'
import { startVoiceListen, stopVoiceListen, voiceListenEnabled } from '../utils/voiceListenRuntime.js'

/**
 * Native listening mode (step 2): while the REPL is mounted and
 * FNHARNESS_VOICE_LISTEN=1, the voice child feeds the command queue with
 * origin `voice`. A no-op without the variable. If another session already
 * holds the voice lock, this one simply does not listen.
 */
export function useVoiceListen(): void {
  useEffect(() => {
    if (!voiceListenEnabled()) return
    startVoiceListen()
    return () => stopVoiceListen()
  }, [])
}
