import { describe, expect, test } from 'bun:test'
import {
  buildNotifySendArgs,
  deliverPushNotification,
  describeDelivery,
  isPushNotificationEnabled,
  sanitizeNotificationText,
} from './pushNotification.js'

describe('pure helpers', () => {
  test('sanitize strips control chars, collapses spaces and truncates', () => {
    expect(sanitizeNotificationText('  hola\n\x07\tmundo  ', 50)).toBe('hola mundo')
    const long = sanitizeNotificationText('x'.repeat(300), 20)
    expect(long.length).toBe(20)
    expect(long.endsWith('…')).toBe(true)
  })

  test('setting is on unless explicitly false', () => {
    expect(isPushNotificationEnabled({})).toBe(true)
    expect(isPushNotificationEnabled({ pushNotificationEnabled: true })).toBe(true)
    expect(isPushNotificationEnabled({ pushNotificationEnabled: false })).toBe(false)
  })

  test('notify-send args are silent and guard the title with --', () => {
    const args = buildNotifySendArgs('-t', 'msg')
    expect(args).toContain('boolean:suppress-sound:true')
    expect(args.slice(-3)).toEqual(['--', '-t', 'msg'])
  })
})

describe('deliverPushNotification', () => {
  const ok = { code: 0 }
  test('uses notify-send when present', async () => {
    const calls: string[][] = []
    const d = await deliverPushNotification(
      { message: 'build listo', title: 'CI' },
      { which: async () => '/usr/bin/notify-send', exec: async (f, a) => (calls.push([f, ...a]), ok) },
    )
    expect(d).toEqual({ channel: 'desktop', binary: '/usr/bin/notify-send' })
    expect(calls[0]?.slice(-2)).toEqual(['CI', 'build listo'])
  })

  test('falls back to the TUI when notify-send is missing', async () => {
    const shown: string[] = []
    const d = await deliverPushNotification(
      { message: 'hola' },
      { which: async () => null, exec: async () => ok, showInTui: t => shown.push(t) },
    )
    expect(d.channel).toBe('tui')
    expect(shown).toEqual(['hola'])
  })

  test('falls back to the TUI when notify-send fails or throws', async () => {
    const shown: string[] = []
    const base = { which: async () => '/x/notify-send', showInTui: (t: string) => shown.push(t) }
    expect((await deliverPushNotification({ message: 'a', title: 'T' }, { ...base, exec: async () => ({ code: 1 }) })).channel).toBe('tui')
    expect((await deliverPushNotification({ message: 'b' }, { ...base, exec: async () => { throw new Error('boom') } })).channel).toBe('tui')
    expect(shown).toEqual(['T: a', 'b'])
  })

  test('reports none when headless and no notifier', async () => {
    const d = await deliverPushNotification({ message: 'x' }, { which: async () => null, exec: async () => ok })
    expect(d.channel).toBe('none')
    expect(describeDelivery(d)).toContain('not delivered')
  })
})
