import { useEffect } from 'react'
import { installVoiceSpeak } from '../utils/voiceSpeakRuntime.js'
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
    const uninstallSpeak = installVoiceSpeak() // barge-in: speech_start cancels the spoken output
    startVoiceListen()
    return () => {
      uninstallSpeak()
      stopVoiceListen()
    }
  }, [])
}
