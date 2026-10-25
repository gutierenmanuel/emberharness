import { describe, expect, test } from 'bun:test'
import { reorderAttachmentsForAPI } from './messages.js'

const ctx = {
  type: 'user',
  isMeta: true,
  message: {
    role: 'user',
    content:
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nx\n</system-reminder>\n",
  },
} as any
const prompt = { type: 'user', message: { role: 'user', content: 'hola' } } as any
const hook = { type: 'attachment', attachment: { type: 'hook_success' } } as any

describe('reorderAttachmentsForAPI', () => {
  test('attachments stay after the stable context message, not before it', () => {
    const out = reorderAttachmentsForAPI([ctx, hook, prompt])
    expect(out[0]).toBe(ctx)
    expect(out[1]).toBe(hook)
  })
  test('without a context message they still bubble to the top', () => {
    const out = reorderAttachmentsForAPI([prompt, hook])
    expect(out[0]).toBe(hook)
  })
})
