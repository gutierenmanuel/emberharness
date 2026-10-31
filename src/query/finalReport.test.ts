import { describe, expect, test } from 'bun:test'
import { isParentReportingQuery, lacksFinalText } from './finalReport.js'

const asst = (...content: object[]) => ({ type: 'assistant', message: { content } })

describe('subagent final report', () => {
  test('a turn with only tool use, thinking or blank text lacks the report', () => {
    expect(lacksFinalText([asst({ type: 'thinking', thinking: 'hmm' })])).toBe(true)
    expect(lacksFinalText([asst({ type: 'text', text: '  \n' })])).toBe(true)
    expect(lacksFinalText([asst()])).toBe(true)
    expect(lacksFinalText([])).toBe(true)
  })
  test('any non-blank text counts as the report', () => {
    expect(lacksFinalText([asst({ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Hecho.' })])).toBe(false)
  })
  test('only subagent loops that are not teammates are nudged', () => {
    expect(isParentReportingQuery('agent:custom', 'a1', false)).toBe(true)
    expect(isParentReportingQuery('agent:builtin:fork', 'a1', false)).toBe(true)
    expect(isParentReportingQuery('repl_main_thread', undefined, false)).toBe(false)
    expect(isParentReportingQuery('agent:custom', undefined, false)).toBe(false)
    expect(isParentReportingQuery('agent:custom', 'a1', true)).toBe(false)
    expect(isParentReportingQuery('session_memory', 'a1', false)).toBe(false)
  })
})
