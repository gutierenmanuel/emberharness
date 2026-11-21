import type { LocalCommandCall } from '../../types/command.js'
import {
  startVoiceListen,
  stopVoiceListen,
  voiceListenStatus,
  type VoiceStartResult,
  type VoiceStatus,
} from '../../utils/voiceListenRuntime.js'

const USAGE = 'Uso: /escucha on | off | estado'

export type EscuchaAction = 'on' | 'off' | 'estado'

/** Pure: arguments → action, or null when they make no sense. */
export function parseEscuchaArgs(args: string): EscuchaAction | null {
  const a = args.trim().toLowerCase()
  if (a === '') return 'estado'
  if (['on', 'si', 'sí', 'activar', 'encender'].includes(a)) return 'on'
  if (['off', 'no', 'desactivar', 'apagar'].includes(a)) return 'off'
  if (['estado', 'status', 'state'].includes(a)) return 'estado'
  return null
}

function hhmmss(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Pure: one line with the state. Of the last utterance only the mic and the time, never the text. */
export function formatEstado(s: VoiceStatus): string {
  if (!s.running) return 'Escucha: apagada'
  const state = s.speaking ? 'hablando' : s.ready ? 'escuchando' : 'arrancando el micrófono'
  const last = s.lastMic !== null && s.lastAt !== null ? `última frase: ${s.lastMic} a las ${hhmmss(s.lastAt)}` : 'sin frases todavía'
  const restarts = s.restarts > 0 ? ` · reinicios del hijo: ${s.restarts}` : ''
  return `Escucha: ${state} · frases: ${s.utterances} · ${last}${restarts}`
}

export function describeStart(r: VoiceStartResult): string {
  if (r.started) return 'Escucha encendida: lo que digas llegará como mensaje tuyo.'
  switch (r.reason) {
    case 'already_running':
      return 'La escucha ya estaba encendida.'
    case 'locked':
      return 'No se enciende: otra sesión ya está escuchando (lock tomado). Apágala allí con /escucha off.'
    case 'empty_cmd':
      return 'No se enciende: FNHARNESS_VOICE_CMD está vacío.'
  }
}

export const call: LocalCommandCall = async args => {
  const action = parseEscuchaArgs(args)
  if (action === null) return { type: 'text', value: USAGE }
  if (action === 'on') return { type: 'text', value: describeStart(startVoiceListen()) }
  if (action === 'off') {
    const was = voiceListenStatus().running
    stopVoiceListen()
    return { type: 'text', value: was ? 'Escucha apagada.' : 'La escucha ya estaba apagada.' }
  }
  return { type: 'text', value: formatEstado(voiceListenStatus()) }
}
