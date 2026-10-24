import { describe, expect, test } from 'bun:test'
import {
  GOAL_DEFAULT_MAX_TURNS,
  GOAL_MAX_IDLE_TURNS,
  buildJudgePrompt,
  decideAfterTurn,
  formatDuration,
  formatIndicator,
  formatOutcome,
  formatStatus,
  formatTokens,
  messagesSince,
  messagesToEntries,
  newGoalState,
  parseGoalArgs,
  parseVerdict,
  renderTranscript,
  turnUsedTools,
} from './goalLogic.js'

describe('parseGoalArgs', () => {
  test('empty is status, clear words clear', () => {
    expect(parseGoalArgs('  ')).toEqual({ kind: 'status' })
    expect(parseGoalArgs('clear')).toEqual({ kind: 'clear' })
    expect(parseGoalArgs('OFF')).toEqual({ kind: 'clear' })
  })
  test('plain condition', () => {
    expect(parseGoalArgs('all tests pass')).toEqual({
      kind: 'set',
      condition: 'all tests pass',
      judge: null,
      maxTurns: null,
    })
  })
  test('flags anywhere, both forms', () => {
    expect(parseGoalArgs('--judge claude fix the build --turns 5')).toEqual({
      kind: 'set',
      condition: 'fix the build',
      judge: 'claude',
      maxTurns: 5,
    })
    expect(parseGoalArgs('fix it --judge=openai --turns=9')).toMatchObject({ judge: 'openai', maxTurns: 9 })
  })
  test('"clear" inside a longer condition is not a clear', () => {
    expect(parseGoalArgs('clear the cache dir')).toMatchObject({ kind: 'set' })
  })
  test('errors', () => {
    expect(parseGoalArgs('--judge claude').kind).toBe('error')
    expect(parseGoalArgs('x --turns').kind).toBe('error')
    expect(parseGoalArgs('x --turns 0').kind).toBe('error')
    expect(parseGoalArgs('x --turns abc').kind).toBe('error')
    expect(parseGoalArgs('x --judge --turns 3').kind).toBe('error')
  })
})

describe('decideAfterTurn', () => {
  const base = newGoalState('c', { maxTurns: 3, now: 0 })
  const turn = { usedTools: true, totalTokens: 100, lastUuid: 'u1' }
  test('met and impossible end immediately and count the turn', () => {
    const met = decideAfterTurn(base, { status: 'met', reason: 'ok' }, turn)
    expect(met.action).toBe('achieved')
    expect(met.state.turns).toBe(1)
    expect(met.state.tokens).toBe(100)
    expect(decideAfterTurn(base, { status: 'impossible', reason: 'no' }, turn).action).toBe('impossible')
  })
  test('not met continues and records reason', () => {
    const d = decideAfterTurn(base, { status: 'not_met', reason: 'tests fail' }, turn)
    expect(d.action).toBe('continue')
    expect(d.state.lastReason).toBe('tests fail')
    expect(d.state.lastUuid).toBe('u1')
  })
  test('idle streak stops after the limit and resets on tool use', () => {
    let s = newGoalState('c', { maxTurns: 99, now: 0 })
    const idle = { usedTools: false, totalTokens: 1, lastUuid: null }
    for (let i = 0; i < GOAL_MAX_IDLE_TURNS - 1; i++) {
      const d = decideAfterTurn(s, { status: 'not_met', reason: '' }, idle)
      expect(d.action).toBe('continue')
      s = d.state
    }
    const reset = decideAfterTurn(s, { status: 'not_met', reason: '' }, turn)
    expect(reset.state.idleStreak).toBe(0)
    expect(decideAfterTurn(s, { status: 'not_met', reason: '' }, idle).action).toBe('idle')
  })
  test('turn cap', () => {
    let s = base
    let last = decideAfterTurn(s, { status: 'not_met', reason: '' }, turn)
    expect(last.action).toBe('continue')
    s = last.state
    last = decideAfterTurn(s, { status: 'not_met', reason: '' }, turn)
    s = last.state
    expect(decideAfterTurn(s, { status: 'not_met', reason: '' }, turn).action).toBe('max_turns')
  })
  test('tokens are the delta since the previous mark', () => {
    const s0 = newGoalState('c', { now: 0, tokenMark: 1000 })
    const d1 = decideAfterTurn(s0, { status: 'not_met', reason: '' }, { usedTools: true, totalTokens: 1500, lastUuid: null })
    expect(d1.state.tokens).toBe(500)
    const d2 = decideAfterTurn(d1.state, { status: 'not_met', reason: '' }, { usedTools: true, totalTokens: 1800, lastUuid: null })
    expect(d2.state.tokens).toBe(800)
  })
  test('default cap', () => {
    expect(newGoalState('c').maxTurns).toBe(GOAL_DEFAULT_MAX_TURNS)
  })
})

describe('formatting', () => {
  test('duration and tokens', () => {
    expect(formatDuration(5000)).toBe('5s')
    expect(formatDuration(134_000)).toBe('2m 14s')
    expect(formatDuration(3_900_000)).toBe('1h 05m')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(250_000)).toBe('250k')
  })
  test('indicator and status', () => {
    const s = { ...newGoalState('make the thing work', { now: 0 }), turns: 3, tokens: 12_400 }
    const line = formatIndicator(s, 134_000)
    expect(line).toContain('turno 3/30')
    expect(line).toContain('2m 14s')
    expect(line).toContain('12.4k tokens')
    expect(formatStatus(null, 0)).toContain('Sin objetivo')
    expect(formatStatus({ ...s, lastReason: 'nope' }, 1000)).toContain('Último veredicto: nope')
  })
  test('outcomes mention stats', () => {
    const s = { ...newGoalState('c', { now: 0 }), turns: 2, lastReason: 'done' }
    expect(formatOutcome('achieved', s, 1000)).toContain('cumplido')
    expect(formatOutcome('idle', s, 1000)).toContain('sin usar herramientas')
    expect(formatOutcome('max_turns', s, 1000)).toContain('tope de 30')
    expect(formatOutcome('judge_error', s, 1000, 'boom')).toContain('boom')
  })
})

describe('parseVerdict', () => {
  test('bare, fenced, embedded and legacy shapes', () => {
    expect(parseVerdict('{"status":"met","reason":"r"}')).toEqual({ status: 'met', reason: 'r' })
    expect(parseVerdict('```json\n{"status":"impossible","reason":"x"}\n```').status).toBe('impossible')
    expect(parseVerdict('Sure! {"status":"not_met","reason":"y"} bye').reason).toBe('y')
    expect(parseVerdict('{"ok":true}').status).toBe('met')
    expect(parseVerdict('{"ok":false,"reason":"z"}')).toEqual({ status: 'not_met', reason: 'z' })
  })
  test('garbage is not_met, never met', () => {
    const v = parseVerdict('I think it is done!')
    expect(v.status).toBe('not_met')
    expect(v.reason).toContain('done')
    expect(parseVerdict('').status).toBe('not_met')
  })
})

describe('transcript helpers', () => {
  const msgs = [
    { type: 'user', uuid: 'a', message: { content: 'please fix' } },
    {
      type: 'assistant',
      uuid: 'b',
      message: {
        content: [
          { type: 'text', text: 'running tests' },
          { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    },
    { type: 'user', uuid: 'c', message: { content: [{ type: 'tool_result', content: '3 pass 0 fail' }] } },
    { type: 'user', uuid: 'd', isMeta: true, message: { content: 'meta nudge' } },
  ]
  test('entries flatten text, tool calls and results; meta users are skipped', () => {
    const e = messagesToEntries(msgs)
    expect(e.map(x => x.role)).toEqual(['user', 'assistant', 'assistant', 'tool'])
    expect(e[2]!.text).toContain('Bash')
    expect(e[3]!.text).toBe('3 pass 0 fail')
  })
  test('render keeps newest within budget', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ role: 'tool' as const, text: `line ${i} ${'x'.repeat(50)}` }))
    const out = renderTranscript(entries, 400)
    expect(out).toContain('line 49')
    expect(out).not.toContain('line 0 ')
    expect(out).toContain('earlier transcript omitted')
    expect(out.length).toBeLessThan(600)
  })
  test('tools, tokens, since', () => {
    expect(turnUsedTools(msgs)).toBe(true)
    expect(turnUsedTools([msgs[0]!, msgs[2]!])).toBe(false)
    expect(messagesSince(msgs, 'b').map(m => m.uuid)).toEqual(['c', 'd'])
    expect(messagesSince(msgs, 'zzz')).toHaveLength(4)
    expect(messagesSince(msgs, null)).toHaveLength(4)
  })
  test('judge prompt embeds condition and transcript', () => {
    const p = buildJudgePrompt('tests pass', 'ASSISTANT: hi')
    expect(p).toContain('tests pass')
    expect(p).toContain('ASSISTANT: hi')
  })
})
