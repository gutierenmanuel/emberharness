import { describe, expect, test } from 'bun:test'
import { buildSubagentPrompt, parseSubagentArgs, subagentUsage } from './subagentCommandLogic.js'

describe('parseSubagentArgs', () => {
  test('plain instruction', () => {
    expect(parseSubagentArgs('  cuenta los ficheros  ', 'fork')).toEqual({
      kind: 'run',
      directive: 'cuenta los ficheros',
      model: null,
    })
  })
  test('--model anywhere, both spellings', () => {
    expect(parseSubagentArgs('--model claude:haiku haz algo', 'subtask')).toEqual({
      kind: 'run', directive: 'haz algo', model: 'claude:haiku',
    })
    expect(parseSubagentArgs('haz algo --model=haiku ya', 'fork')).toEqual({
      kind: 'run', directive: 'haz algo ya', model: 'haiku',
    })
  })
  test('empty instruction is an error with usage', () => {
    const r = parseSubagentArgs('   ', 'fork')
    expect(r.kind).toBe('error')
    expect(r.kind === 'error' && r.message).toContain(subagentUsage('fork'))
    expect(parseSubagentArgs('--model haiku', 'subtask').kind).toBe('error')
  })
  test('--model without value is an error', () => {
    expect(parseSubagentArgs('haz algo --model', 'fork').kind).toBe('error')
    expect(parseSubagentArgs('--model --otro haz', 'fork').kind).toBe('error')
  })
})

describe('buildSubagentPrompt', () => {
  test('fork uses subagent_type fork, background, verbatim directive', () => {
    const p = buildSubagentPrompt('fork', 'revisa X', null)
    expect(p).toContain('subagent_type: "fork"')
    expect(p).toContain('run_in_background: true')
    expect(p).not.toContain('model:')
    expect(p.endsWith('Instruction:\nrevisa X')).toBe(true)
  })
  test('subtask is general-purpose with a self-contained brief and model', () => {
    const p = buildSubagentPrompt('subtask', 'revisa X', 'claude:haiku')
    expect(p).toContain('subagent_type: "general-purpose"')
    expect(p).toContain('model: "claude:haiku"')
    expect(p).toContain('NOTHING of this conversation')
  })
})
