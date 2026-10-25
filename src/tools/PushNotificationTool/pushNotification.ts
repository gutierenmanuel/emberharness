// PushNotification, local version: a desktop notification through
// `notify-send` when it exists, else a notice inside the TUI. Never any sound.

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'
export const MAX_TITLE_CHARS = 60
export const MAX_MESSAGE_CHARS = 200
const DEFAULT_TITLE = 'FnHarness'

/** Pure: one line, no control characters, at most `max` characters. */
export function sanitizeNotificationText(text: string, max: number): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean
}

/** Pure: whether the setting allows push notifications (on unless false). */
export function isPushNotificationEnabled(settings: {
  pushNotificationEnabled?: boolean
}): boolean {
  return settings.pushNotificationEnabled !== false
}

/**
 * Pure: notify-send arguments. `suppress-sound` is the freedesktop hint that
 * silences the sound; `--` keeps a title starting with "-" from being a flag.
 */
export function buildNotifySendArgs(title: string, message: string): string[] {
  return [
    '-a',
    DEFAULT_TITLE,
    '-u',
    'normal',
    '-t',
    '10000',
    '-h',
    'boolean:suppress-sound:true',
    '--',
    title,
    message,
  ]
}

export type PushDelivery =
  | { channel: 'desktop'; binary: string }
  | { channel: 'tui' }
  | { channel: 'none' }

export type PushDeps = {
  which: (cmd: string) => Promise<string | null>
  exec: (file: string, args: string[]) => Promise<{ code: number }>
  /** TUI notice; absent in headless runs. */
  showInTui?: (text: string) => void
}

/** notify-send first; if missing or failing, the TUI notice; else nothing. */
export async function deliverPushNotification(
  input: { message: string; title?: string },
  deps: PushDeps,
): Promise<PushDelivery> {
  const title = sanitizeNotificationText(input.title ?? '', MAX_TITLE_CHARS) || DEFAULT_TITLE
  const message = sanitizeNotificationText(input.message, MAX_MESSAGE_CHARS)
  const binary = await deps.which('notify-send')
  if (binary) {
    try {
      const r = await deps.exec(binary, buildNotifySendArgs(title, message))
      if (r.code === 0) return { channel: 'desktop', binary }
    } catch {
      // fall through to the TUI notice
    }
  }
  if (deps.showInTui) {
    deps.showInTui(title === DEFAULT_TITLE ? message : `${title}: ${message}`)
    return { channel: 'tui' }
  }
  return { channel: 'none' }
}

/** Pure: text of the tool result for the model. */
export function describeDelivery(d: PushDelivery): string {
  switch (d.channel) {
    case 'desktop':
      return 'Notification sent to the desktop.'
    case 'tui':
      return 'No desktop notifier available: the notice was shown in the terminal UI.'
    case 'none':
      return 'Notification not delivered: no desktop notifier (notify-send) and no interactive UI.'
  }
}
