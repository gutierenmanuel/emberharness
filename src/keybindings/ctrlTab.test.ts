import { describe, expect, test } from 'bun:test'
import { InputEvent } from '../ink/events/input-event.js'
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedKey } from '../ink/parse-keypress.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { matchesKeystroke } from './match.js'
import { parseKeystroke } from './parser.js'

function eventFor(seq: string): InputEvent {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, seq)
  const k = keys.find(x => x.kind === 'key') as ParsedKey
  return new InputEvent(k)
}

const matches = (seq: string, binding: string) => {
  const e = eventFor(seq)
  return matchesKeystroke(e.input, e.key, parseKeystroke(binding))
}

describe('ctrl+tab encodings', () => {
  test.each([
    ['kitty CSI u', '\x1b[9;5u'],
    ['xterm modifyOtherKeys', '\x1b[27;5;9~'],
  ])('%s is ctrl+tab, not tab or shift+tab', (_, seq) => {
    expect(matches(seq, 'ctrl+tab')).toBe(true)
    expect(matches(seq, 'tab')).toBe(false)
    expect(matches(seq, 'shift+tab')).toBe(false)
  })
  test.each([
    ['kitty CSI u', '\x1b[9;6u'],
    ['xterm modifyOtherKeys', '\x1b[27;6;9~'],
  ])('%s is ctrl+shift+tab', (_, seq) => {
    expect(matches(seq, 'ctrl+shift+tab')).toBe(true)
    expect(matches(seq, 'shift+tab')).toBe(false)
    expect(matches(seq, 'ctrl+tab')).toBe(false)
  })
  test('plain tab and shift+tab keep their meaning', () => {
    expect(matches('\t', 'tab')).toBe(true)
    expect(matches('\t', 'ctrl+tab')).toBe(false)
    expect(matches('\x1b[Z', 'shift+tab')).toBe(true)
    expect(matches('\x1b[Z', 'ctrl+shift+tab')).toBe(false)
  })
  test('default Chat bindings map ctrl+tab to the context profile cycle', () => {
    const chat = DEFAULT_BINDINGS.find(b => b.context === 'Chat')!.bindings
    expect(chat['ctrl+tab']).toBe('chat:cycleContextProfile')
    expect(chat['ctrl+shift+tab']).toBe('chat:cycleContextProfileBack')
  })
})
