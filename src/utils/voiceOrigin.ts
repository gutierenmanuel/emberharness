/**
 * Voice origin helpers (native listening mode, step 2).
 *
 * The `MessageOrigin` union lives in `src/types/message.ts`, which is not part
 * of this tree -I 'PentestingEverything|botnet_lab|c2_lab|cyber|cyber.1.jsonl|cyber.jsonl|cybersecurity|offensive-*|offensive-hacking|web_attack_console' (quarantined), so the minimal shape of the voice variant is
 * defined here. Everything in this module is pure: the text a person speaks
 * is wrapped, unwrapped and labelled here, never logged.
 */

export type VoiceOrigin = { kind: 'voice'; mic: string }

/** Opening of the text the model sees when a voice utterance arrives mid-turn. */
export const VOICE_WRAP_PREFIX = 'La persona dijo por voz mientras trabajabas:'

const VOICE_WRAP_SUFFIX =
  'Es texto de la persona (dictado por voz, puede traer errores de transcripción). Atiéndelo al terminar lo que estás haciendo.'

/** Normalises a microphone name to something safe to print and to carry in origin. */
export function sanitizeMic(mic: unknown): string {
  if (typeof mic !== 'string') return 'mic'
  return /^[\w.-]{1,32}$/.test(mic) ? mic : 'mic'
}

/** Text the model receives for a voice utterance that arrives between tool rounds. */
export function wrapVoiceText(raw: string): string {
  return `${VOICE_WRAP_PREFIX}\n${raw}\n\n${VOICE_WRAP_SUFFIX}`
}

/** Inverse of `wrapVoiceText`, so the transcript shows what was said and not the wrapper. */
export function unwrapVoiceText(text: string): string {
  if (!text.startsWith(VOICE_WRAP_PREFIX)) return text
  const body = text.slice(VOICE_WRAP_PREFIX.length).replace(/^\n/, '')
  const cut = body.lastIndexOf(`\n\n${VOICE_WRAP_SUFFIX}`)
  return cut >= 0 ? body.slice(0, cut) : body
}

/** Visible transcript label: «🎙 yo(omi): hola». */
export function voiceDisplayText(text: string, origin: VoiceOrigin): string {
  return `🎙 yo(${origin.mic}): ${unwrapVoiceText(text)}`
}

export function isVoiceOrigin(origin: unknown): origin is VoiceOrigin {
  return (
    typeof origin === 'object' &&
    origin !== null &&
    (origin as { kind?: unknown }).kind === 'voice'
  )
}
