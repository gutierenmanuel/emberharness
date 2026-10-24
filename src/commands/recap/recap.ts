import { generateAwaySummary } from '../../services/awaySummary.js'
import type { LocalCommandCall } from '../../types/command.js'
import { formatRecap } from './formatRecap.js'

export const call: LocalCommandCall = async (_args, context) => {
  if (context.messages.length === 0) {
    return { type: 'text', value: 'Nothing to recap yet: the session is empty.' }
  }
  const text = await generateAwaySummary(
    context.messages,
    context.abortController.signal,
  )
  const line = formatRecap(text)
  return {
    type: 'text',
    value: line ?? 'Could not generate a recap (see --debug for details).',
  }
}
