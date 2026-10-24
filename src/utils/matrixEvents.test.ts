import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MATRIX_EVENTS_VERSION,
  buildAskAnswers,
  buildEvent,
  drainLines,
  initialFlow,
  parseInputLine,
  serializeEvent,
  stepFlow,
  toAskQuestions,
  truncate,
  type EventBody,
  type FlowAction,
  type FlowEvent,
  type FlowState,
} from './matrixEvents.js'
import {
  createEventSink,
  emitMatrix,
  handleInputLine,
  matrixIdle,
  matrixSessionStart,
  matrixTurnEnd,
  matrixTurnStart,
  resetMatrixRuntimeForTesting,
  startFifoReader,
  attachMatrixControls,
  announceAskDialog,
  bindAskSubmit,
  markAskAnswered,
} from './matrixEventsRuntime.js'

const NOW = new Date('2026-10-24T17:02:11.120Z')

describe('buildEvent / serializeEvent', () => {
  test('adds the common fields in the contract', () => {
    const e = buildEvent({ seq: 3, now: NOW, sessionId: 'sid' }, { type: 'turn_start', source: 'user' })
    expect(e).toEqual({
      v: MATRIX_EVENTS_VERSION,
      seq: 3,
      ts: '2026-10-24T17:02:11.120Z',
      session_id: 'sid',
      type: 'turn_start',
      source: 'user',
    })
    expect(MATRIX_EVENTS_VERSION).toBe(1)
  })

  test('serializes to exactly one line', () => {
    const line = serializeEvent(
      buildEvent({ seq: 1, now: NOW, sessionId: 's' }, {
        type: 'permission_prompt',
        tool_use_id: 't',
        tool: 'Bash',
        summary: 'line1\nline2',
      }),
    )
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line).summary).toBe('line1\nline2')
  })

  test('every event type carries its own fields', () => {
    const bodies: EventBody[] = [
      { type: 'session_start', cwd: '/x', account: 'a', model: 'm', resumed: false, pid: 1 },
      { type: 'ready' },
      { type: 'turn_end', reason: 'completed' },
      { type: 'ask_user', tool_use_id: 't', questions: [] },
      { type: 'ask_user_done', tool_use_id: 't', answered: true },
      { type: 'input_queued', id: 'i', text_len: 2 },
      { type: 'input_accepted', id: 'i', text_len: 2 },
      { type: 'session_switch', old_session_id: 'a', new_session_id: 'b', reason: 'clear' },
      { type: 'exit', code: 0 },
    ]
    for (const b of bodies) {
      const e = buildEvent({ seq: 1, now: NOW, sessionId: 's' }, b)
      expect(Object.keys(e)).toEqual(expect.arrayContaining(['v', 'seq', 'ts', 'session_id', 'type']))
    }
  })

  test('truncate flattens whitespace and cuts', () => {
    expect(truncate('a  b\n c', 20)).toBe('a b c')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })

  test('toAskQuestions fills defaults', () => {
    expect(
      toAskQuestions([{ question: 'q?', options: [{ label: 'A' }, { label: 'B', description: 'b' }] }]),
    ).toEqual([
      {
        header: '',
        question: 'q?',
        multiSelect: false,
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: 'b' },
        ],
      },
    ])
  })
})

describe('parseInputLine', () => {
  test('prompt', () => {
    expect(parseInputLine('{"type":"prompt","id":"7","text":"hola"}')).toEqual({
      ok: true,
      msg: { type: 'prompt', id: '7', text: 'hola' },
    })
    const numeric = parseInputLine('{"type":"prompt","id":7,"text":"x"}')
    expect(numeric).toEqual({ ok: true, msg: { type: 'prompt', id: '7', text: 'x' } })
  })

  test('ask_answer with selected and with text', () => {
    expect(parseInputLine('{"type":"ask_answer","tool_use_id":"t","selected":["A"]}')).toEqual({
      ok: true,
      msg: { type: 'ask_answer', tool_use_id: 't', selected: ['A'] },
    })
    expect(parseInputLine('{"type":"ask_answer","tool_use_id":"t","text":"libre"}')).toEqual({
      ok: true,
      msg: { type: 'ask_answer', tool_use_id: 't', selected: [], text: 'libre' },
    })
  })

  test('interrupt', () => {
    expect(parseInputLine('{"type":"interrupt"}')).toEqual({ ok: true, msg: { type: 'interrupt' } })
  })

  test.each([
    ['', 'empty'],
    ['not json', 'not valid JSON'],
    ['[1]', 'not a JSON object'],
    ['{"type":"nope"}', 'unknown type'],
    ['{"type":"prompt","text":"x"}', 'without id'],
    ['{"type":"prompt","id":"1","text":""}', 'without text'],
    ['{"type":"ask_answer","selected":["A"]}', 'tool_use_id'],
    ['{"type":"ask_answer","tool_use_id":"t"}', 'without selected'],
    ['{"type":"ask_answer","tool_use_id":"t","selected":[1]}', 'list of labels'],
  ])('rejects %p', (line, why) => {
    const r = parseInputLine(line)
    expect(r.ok).toBe(false)
    expect('reason' in r && r.reason).toContain(why.split(' ')[0] === 'empty' ? 'empty' : why)
  })
})

describe('drainLines', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  test('splits complete lines and keeps the tail', () => {
    const a = drainLines(new Uint8Array(0), enc('one\ntwo\nthr'))
    expect(a.lines).toEqual(['one', 'two'])
    const b = drainLines(a.carry, enc('ee\n'))
    expect(b.lines).toEqual(['three'])
    expect(b.carry.length).toBe(0)
  })

  test('a multi-byte character cut across chunks is decoded whole', () => {
    const bytes = enc('ñandú\n')
    const a = drainLines(new Uint8Array(0), bytes.subarray(0, 1))
    const b = drainLines(a.carry, bytes.subarray(1))
    expect(b.lines).toEqual(['ñandú'])
  })

  test('drops a tail that never ends', () => {
    const big = new Uint8Array(1024 * 1024 + 1).fill(97)
    const r = drainLines(new Uint8Array(0), big)
    expect(r.overflow).toBe(true)
    expect(r.carry.length).toBe(0)
  })
})

describe('buildAskAnswers', () => {
  const single = [{ question: 'Tienda?', multiSelect: false }]
  const multi = [{ question: 'Extras?', multiSelect: true }]
  const two = [{ question: 'A?' }, { question: 'B?' }]
  const ans = (o: object) => ({ type: 'ask_answer' as const, tool_use_id: 't', selected: [], ...o })

  test('single choice', () => {
    expect(buildAskAnswers(single, ans({ selected: ['Dia'] }))).toEqual({ 'Tienda?': 'Dia' })
  })
  test('free text wins for single choice', () => {
    expect(buildAskAnswers(single, ans({ text: 'Lidl' }))).toEqual({ 'Tienda?': 'Lidl' })
  })
  test('multi-select joins labels and free text', () => {
    expect(buildAskAnswers(multi, ans({ selected: ['x', 'y'], text: 'z' }))).toEqual({ 'Extras?': 'x, y, z' })
  })
  test('several questions are positional', () => {
    expect(buildAskAnswers(two, ans({ selected: ['1', '2'] }))).toEqual({ 'A?': '1', 'B?': '2' })
    expect(buildAskAnswers(two, ans({ selected: ['1'] }))).toBeNull()
  })
  test('explicit answers map', () => {
    expect(buildAskAnswers(two, ans({ answers: { 'A?': 'x', 'B?': 'y', 'C?': 'z' } }))).toEqual({ 'A?': 'x', 'B?': 'y' })
    expect(buildAskAnswers(two, ans({ answers: { 'A?': 'x' } }))).toBeNull()
  })
  test('nothing usable', () => {
    expect(buildAskAnswers(single, ans({}))).toBeNull()
  })
})

describe('stepFlow', () => {
  function run(events: FlowEvent[], from: FlowState = initialFlow) {
    let state = from
    const actions: FlowAction[] = []
    for (const e of events) {
      const r = stepFlow(state, e)
      state = r.state
      actions.push(...r.actions)
    }
    return { state, actions }
  }
  const types = (actions: FlowAction[]) =>
    actions.map(a => (a.kind === 'emit' ? a.body.type : a.kind))

  test('ready once when the prompt becomes idle', () => {
    const { actions } = run([
      { kind: 'idle', idle: true },
      { kind: 'idle', idle: true },
    ])
    expect(types(actions)).toEqual(['ready'])
  })

  test('turn_start, turn_end, ready in order; never ready inside a turn', () => {
    const { actions } = run([
      { kind: 'idle', idle: true },
      { kind: 'idle', idle: false },
      { kind: 'turn_start', source: 'user' },
      { kind: 'idle', idle: true }, // forced end of the query: idle before the finally runs
      { kind: 'turn_end', reason: 'interrupted' },
    ])
    expect(types(actions)).toEqual(['ready', 'turn_start', 'turn_end', 'ready'])
  })

  test('a superseded turn does not release ready early', () => {
    const { actions } = run([
      { kind: 'idle', idle: true },
      { kind: 'turn_start', source: 'user' },
      { kind: 'turn_start', source: 'user' },
      { kind: 'turn_end', reason: 'interrupted' },
      { kind: 'idle', idle: true },
    ])
    expect(types(actions)).toEqual(['ready', 'turn_start', 'turn_start', 'turn_end'])
    const done = run([{ kind: 'turn_end', reason: 'completed' }], run(
      [
        { kind: 'idle', idle: true },
        { kind: 'turn_start', source: 'user' },
        { kind: 'turn_start', source: 'user' },
        { kind: 'turn_end', reason: 'interrupted' },
      ],
    ).state)
    expect(types(done.actions)).toEqual(['turn_end', 'ready'])
  })

  test('a prompt while idle is accepted at once', () => {
    const { actions, state } = run([
      { kind: 'idle', idle: true },
      { kind: 'prompt', id: 'p1', text: 'hola' },
    ])
    expect(types(actions)).toEqual(['ready', 'input_accepted', 'submit'])
    expect(actions[2]).toEqual({ kind: 'submit', id: 'p1', text: 'hola', source: 'user' })
    expect(state.submitting).toBe(true)
  })

  test('a second prompt right after is queued, not sent twice', () => {
    const { actions } = run([
      { kind: 'idle', idle: true },
      { kind: 'prompt', id: 'p1', text: 'a' },
      { kind: 'prompt', id: 'p2', text: 'b' },
    ])
    expect(types(actions)).toEqual(['ready', 'input_accepted', 'submit', 'input_queued'])
  })

  test('prompts during a turn are queued and sent one by one after it', () => {
    const { actions, state } = run([
      { kind: 'idle', idle: true },
      { kind: 'idle', idle: false },
      { kind: 'turn_start', source: 'user' },
      { kind: 'prompt', id: 'p1', text: 'uno' },
      { kind: 'prompt', id: 'p2', text: 'dos' },
      { kind: 'idle', idle: true },
      { kind: 'turn_end', reason: 'completed' },
    ])
    expect(types(actions)).toEqual([
      'ready',
      'turn_start',
      'input_queued',
      'input_queued',
      'turn_end',
      'input_accepted',
      'submit',
    ])
    const submit = actions.find(a => a.kind === 'submit')!
    expect(submit).toEqual({ kind: 'submit', id: 'p1', text: 'uno', source: 'queued' })
    expect(state.pending.map(p => p.id)).toEqual(['p2'])
    // After p1's turn the next one goes out, and `ready` only when the queue is empty.
    const next = run(
      [
        { kind: 'idle', idle: false },
        { kind: 'turn_start', source: 'queued' },
        { kind: 'idle', idle: true },
        { kind: 'turn_end', reason: 'completed' },
        { kind: 'idle', idle: false },
        { kind: 'turn_start', source: 'queued' },
        { kind: 'idle', idle: true },
        { kind: 'turn_end', reason: 'completed' },
      ],
      state,
    )
    expect(types(next.actions)).toEqual([
      'turn_start',
      'turn_end',
      'input_accepted',
      'submit',
      'turn_start',
      'turn_end',
      'ready',
    ])
  })

  test('a submit that never leaves idle (local command) is released by the timeout', () => {
    const { actions } = run([
      { kind: 'idle', idle: true },
      { kind: 'prompt', id: 'p1', text: '/help' },
      { kind: 'submit_timeout' },
    ])
    expect(types(actions)).toEqual(['ready', 'input_accepted', 'submit', 'ready'])
  })

  test('interrupt only acts when something is running', () => {
    expect(run([{ kind: 'idle', idle: true }, { kind: 'interrupt' }]).actions.some(a => a.kind === 'interrupt')).toBe(false)
    expect(
      run([{ kind: 'idle', idle: false }, { kind: 'turn_start', source: 'user' }, { kind: 'interrupt' }]).actions.some(
        a => a.kind === 'interrupt',
      ),
    ).toBe(true)
  })
})

describe('createEventSink', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mx-sink-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('appends one line per event with a monotonic seq, file mode 0600', () => {
    const path = join(dir, 'ev.jsonl')
    const sink = createEventSink(path, () => 'sid', undefined, () => NOW)
    sink.emit({ type: 'ready' })
    sink.emit({ type: 'turn_start', source: 'user' })
    sink.close()
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines.map(l => JSON.parse(l).seq)).toEqual([1, 2])
    expect(JSON.parse(lines[1]!)).toMatchObject({ v: 1, session_id: 'sid', type: 'turn_start', source: 'user' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('appends to an existing file and issues a single write per event', () => {
    const path = join(dir, 'ev.jsonl')
    writeFileSync(path, 'previous\n')
    const writes: string[] = []
    const sink = createEventSink(
      path,
      () => 's',
      {
        open: p => {
          expect(p).toBe(path)
          return 42
        },
        write: (_fd, data) => {
          writes.push(data)
        },
        close: () => {},
      },
      () => NOW,
    )
    sink.emit({ type: 'ready' })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.endsWith('\n')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('previous\n')
  })

  test('tolerates failures and keeps counting seq so the gap is visible', () => {
    let failing = true
    const writes: string[] = []
    const sink = createEventSink(
      '/nonexistent/x.jsonl',
      () => 's',
      {
        open: () => {
          if (failing) throw new Error('EACCES')
          return 1
        },
        write: (_fd, d) => {
          writes.push(d)
        },
        close: () => {},
      },
      () => NOW,
    )
    expect(() => sink.emit({ type: 'ready' })).not.toThrow()
    failing = false
    sink.emit({ type: 'ready' })
    expect(JSON.parse(writes[0]!).seq).toBe(2)
  })

  test('a write error drops the descriptor and recovers on the next event', () => {
    let n = 0
    const opened: number[] = []
    const sink = createEventSink(
      'x',
      () => 's',
      {
        open: () => {
          opened.push(++n)
          return n
        },
        write: fd => {
          if (fd === 1) throw new Error('EIO')
        },
        close: () => {},
      },
      () => NOW,
    )
    sink.emit({ type: 'ready' })
    sink.emit({ type: 'ready' })
    expect(opened).toEqual([1, 2])
  })
})

describe('runtime without environment variables (regression)', () => {
  let dir: string
  const saved = { e: process.env.FNHARNESS_EVENTS, i: process.env.FNHARNESS_INPUT }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mx-off-'))
    delete process.env.FNHARNESS_EVENTS
    delete process.env.FNHARNESS_INPUT
    resetMatrixRuntimeForTesting()
  })
  afterEach(() => {
    if (saved.e === undefined) delete process.env.FNHARNESS_EVENTS
    else process.env.FNHARNESS_EVENTS = saved.e
    if (saved.i === undefined) delete process.env.FNHARNESS_INPUT
    else process.env.FNHARNESS_INPUT = saved.i
    resetMatrixRuntimeForTesting()
    rmSync(dir, { recursive: true, force: true })
  })

  test('every hook is a no-op: nothing is created, no controls attached', () => {
    const before = process.listenerCount('exit')
    matrixSessionStart({ resumed: false })
    matrixIdle(true)
    matrixTurnStart()
    matrixTurnEnd('completed')
    emitMatrix({ type: 'ready' })
    const detach = attachMatrixControls({
      submit: () => {
        throw new Error('must not be called')
      },
      interrupt: () => {
        throw new Error('must not be called')
      },
    })
    detach()
    handleInputLine('{"type":"prompt","id":"1","text":"x"}')
    expect(process.listenerCount('exit')).toBe(before)
    expect(existsSync(join(dir, 'ev.jsonl'))).toBe(false)
  })
})

describe('runtime with the channel on', () => {
  let dir: string
  const saved = { e: process.env.FNHARNESS_EVENTS, i: process.env.FNHARNESS_INPUT }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mx-on-'))
    resetMatrixRuntimeForTesting()
  })
  afterEach(() => {
    if (saved.e === undefined) delete process.env.FNHARNESS_EVENTS
    else process.env.FNHARNESS_EVENTS = saved.e
    if (saved.i === undefined) delete process.env.FNHARNESS_INPUT
    else process.env.FNHARNESS_INPUT = saved.i
    resetMatrixRuntimeForTesting()
    rmSync(dir, { recursive: true, force: true })
  })

  const read = (path: string) =>
    readFileSync(path, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  test('session_start first, then the turn sequence, with prompts submitted through the controls', async () => {
    const events = join(dir, 'ev.jsonl')
    process.env.FNHARNESS_EVENTS = events
    delete process.env.FNHARNESS_INPUT
    matrixSessionStart({ resumed: false })
    const submitted: string[] = []
    const detach = attachMatrixControls({ submit: t => submitted.push(t), interrupt: () => {} })
    matrixIdle(true)
    handleInputLine('{"type":"prompt","id":"p1","text":"hola"}')
    handleInputLine('basura')
    matrixIdle(false)
    matrixTurnStart()
    handleInputLine('{"type":"prompt","id":"p2","text":"luego"}')
    matrixIdle(true)
    matrixTurnEnd('completed')
    detach()
    expect(submitted).toEqual(['hola', 'luego'])
    const evs = read(events)
    expect(evs.map(e => e.type)).toEqual([
      'session_start',
      'ready',
      'input_accepted',
      'turn_start',
      'input_queued',
      'turn_end',
      'input_accepted',
    ])
    expect(evs.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(evs[0]).toMatchObject({ resumed: false, pid: process.pid })
    expect(evs[3]).toMatchObject({ source: 'user' })
  })

  test('ask dialog: ask_user, ask_answer submits, ask_user_done reports answered; a remount does not repeat events', () => {
    const events = join(dir, 'ev.jsonl')
    process.env.FNHARNESS_EVENTS = events
    matrixSessionStart({ resumed: false })
    const questions = toAskQuestions([{ question: 'Tienda?', header: 'T', options: [{ label: 'A' }, { label: 'B' }] }])
    const got: Array<Record<string, string>> = []
    // The body's effect runs before the parent's: binding may precede the announcement.
    bindAskSubmit('tu1', a => {
      markAskAnswered('tu1')
      got.push(a)
    })()
    const close = announceAskDialog('tu1', questions)
    // Remount of the dialog body: binds again; the parent's events are not repeated.
    bindAskSubmit('tu1', a => {
      markAskAnswered('tu1')
      got.push(a)
    })
    handleInputLine('{"type":"ask_answer","tool_use_id":"nope","selected":["A"]}')
    handleInputLine('{"type":"ask_answer","tool_use_id":"tu1","selected":["B"]}')
    close()
    expect(got).toEqual([{ 'Tienda?': 'B' }])
    const evs = read(events)
    expect(evs.map(e => e.type)).toEqual(['session_start', 'ask_user', 'ask_user_done'])
    expect(evs[1]).toMatchObject({ tool_use_id: 'tu1', questions })
    expect(evs[2]).toMatchObject({ tool_use_id: 'tu1', answered: true })
  })

  test('ask dialog dismissed without answer reports answered=false', () => {
    const events = join(dir, 'ev.jsonl')
    process.env.FNHARNESS_EVENTS = events
    matrixSessionStart({ resumed: false })
    announceAskDialog('tu2', [])()
    expect(read(events)[2]).toMatchObject({ type: 'ask_user_done', answered: false })
  })

  test('nothing is emitted before session_start', () => {
    const events = join(dir, 'ev.jsonl')
    process.env.FNHARNESS_EVENTS = events
    emitMatrix({ type: 'ready' })
    matrixIdle(true)
    expect(existsSync(events)).toBe(false)
  })

  test('the FIFO reader delivers lines written by several writers and survives garbage', async () => {
    const fifo = join(dir, 'in.fifo')
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
    const lines: string[] = []
    const stop = startFifoReader(fifo, l => lines.push(l), 10)
    writeFileSync(fifo, '{"type":"interrupt"}\n')
    writeFileSync(fifo, '{"type":"prompt","id":"1","te')
    writeFileSync(fifo, 'xt":"partido"}\nbasura\n')
    const end = Date.now() + 3000
    while (lines.length < 3 && Date.now() < end) await Bun.sleep(20)
    stop()
    expect(lines).toEqual(['{"type":"interrupt"}', '{"type":"prompt","id":"1","text":"partido"}', 'basura'])
  })

  test('a path that is not a FIFO is ignored without throwing', () => {
    const file = join(dir, 'plain')
    writeFileSync(file, '')
    const stop = startFifoReader(file, () => {})
    expect(typeof stop).toBe('function')
    stop()
    expect(startFifoReader(join(dir, 'missing'), () => {})).toBeInstanceOf(Function)
  })
})
