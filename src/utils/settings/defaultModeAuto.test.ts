import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

describe('permissions.defaultMode', () => {
  test('reads "auto" from newer Claude Code settings as "default"', () => {
    const r = SettingsSchema().safeParse({ permissions: { defaultMode: 'auto' } })
    expect(r.success).toBe(true)
    expect(r.success && r.data.permissions?.defaultMode).toBe('default')
  })

  test('still rejects unknown modes', () => {
    expect(SettingsSchema().safeParse({ permissions: { defaultMode: 'yolo' } }).success).toBe(false)
  })
})
