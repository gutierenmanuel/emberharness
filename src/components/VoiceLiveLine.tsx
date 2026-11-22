import * as React from 'react'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { useCommandQueue } from '../hooks/useCommandQueue.js'
import {
  getVoiceLive,
  subscribeVoiceLive,
  voiceLiveExpire,
  voiceLiveNextExpiry,
  voiceLineView,
} from '../utils/voiceLiveState.js'
import { isVoiceOrigin } from '../utils/voiceOrigin.js'

/**
 * One line right above the prompt input with the state of the voice, while
 * listening is on: listening / dictating (live text of the chunks so far) /
 * sent / queued (a voice message waiting for the running tool to finish).
 * Nothing is rendered when listening is off. It never touches the prompt
 * buffer, so whatever the person is typing stays untouched.
 */
function VoiceLiveLineImpl(): React.ReactNode {
  const live = useSyncExternalStore(subscribeVoiceLive, getVoiceLive)
  const queue = useCommandQueue()
  const queuedVoice = useMemo(() => queue.filter(c => isVoiceOrigin(c.origin)).length, [queue])

  // Decay (stale dictation, "sent" confirmation) is time-based: schedule the next one.
  useEffect(() => {
    const ms = voiceLiveNextExpiry()
    if (ms === null) return
    const t = setTimeout(() => voiceLiveExpire(), ms + 5)
    return () => clearTimeout(t)
  }, [live])

  const v = voiceLineView(live, queuedVoice)
  if (v.kind === 'off') return null
  return (
    <Box paddingX={2} flexShrink={0}>
      {v.kind === 'dictating' ? (
        <Text wrap="truncate-start">
          <Text color="cyan">🎙 dictando… </Text>
          <Text>{v.text}</Text>
          {v.waiting > 0 ? <Text dimColor> (+{v.waiting} en cola)</Text> : null}
        </Text>
      ) : v.kind === 'queued' ? (
        <Text color="yellow">
          🎙 en cola ({v.waiting}): se envía al acabar la herramienta en curso
        </Text>
      ) : v.kind === 'sent' ? (
        <Text color="green">🎙 enviado ✓</Text>
      ) : (
        <Text dimColor>🎙 escuchando</Text>
      )}
    </Box>
  )
}

export const VoiceLiveLine = React.memo(VoiceLiveLineImpl)
