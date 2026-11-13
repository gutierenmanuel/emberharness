/**
 * Matrix event channel end to end (docs/matrix_events.md): FNHARNESS_EVENTS
 * (JSONL out) and FNHARNESS_INPUT (FIFO in) on the real ./cli, driven in a
 * pseudo-terminal against a scripted OpenAI-compatible backend. No real
 * provider is contacted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CLI, FAKE_MODEL, fakeEnv, findTranscript, hasCli, makeSandbox } from './harness.js'
import { startTui } from './tui.js'

type Req = { messages: Array<{ role: string; content?: unknown }>; stream?: boolean }
type Ev = { v: number; seq: number; ts: string; session_id: string; type: string; [k: string]: unknown }

const text = (m?: { content?: unknown }): string =>
  typeof m?.content === 'string'
    ? m.content
    : Array.isArray(m?.content)
      ? m!.content.map((p: { text?: string }) => p.text ?? '').join('\n')
      : ''

function sse(deltas: object[], finish: string): string {
  const chunk = (delta: object, fin: string | null) =>
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`
  return (
    deltas.map(d => chunk(d, null)).join('') +
    chunk({}, finish) +
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

const QUESTION = {
  questions: [
    {
      question: '¿Dónde compro?',
      header: 'Tienda',
      multiSelect: false,
      options: [
        { label: 'Mercadona', description: 'cerca' },
        { label: 'Dia', description: 'barato' },
      ],
    },
  ],
}

/**
 * Plays the model: a user message containing PREGUNTA makes it call
 * AskUserQuestion; `HERRAMIENTA <ruta>` makes it say a line and call Read on that path;
 * the tool result gets "gracias"; anything else "hola".
 * `delayMs` keeps each turn busy long enough to queue input behind it.
 */
function startScripted(delayMs: number) {
  const requests: Req[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('nf', { status: 404 })
      const body = (await req.json()) as Req
      const last = body.messages[body.messages.length - 1]!
      if (body.stream === false) {
        return Response.json({
          id: 'x',
          object: 'chat.completion',
          model: FAKE_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'titulo' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        })
      }
      requests.push(body)
      if (delayMs) await Bun.sleep(delayMs)
      const wantsAsk = last.role === 'user' && text(last).includes('PREGUNTA')
      const readFile = last.role === 'user' ? /HERRAMIENTA (\S+)/.exec(text(last))?.[1] : undefined
      const stream = readFile
        ? sse(
            [
              { role: 'assistant', content: 'Voy a leer el fichero' },
              { tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: readFile }) } }] },
            ],
            'tool_calls',
          )
        : wantsAsk
        ? sse(
            [{ role: 'assistant', tool_calls: [{ index: 0, id: 'call_ask', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify(QUESTION) } }] }],
            'tool_calls',
          )
        : sse([{ role: 'assistant', content: last.role === 'tool' ? 'gracias' : 'hola' }], 'stop')
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

function readEvents(path: string): Ev[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Ev)
}

async function waitEvents(path: string, pred: (evs: Ev[]) => boolean, what: string, timeoutMs = 30_000): Promise<Ev[]> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const evs = readEvents(path)
    if (pred(evs)) return evs
    await Bun.sleep(100)
  }
  throw new Error(`timeout waiting for ${what}; events so far: ${readEvents(path).map(e => e.type).join(',')}`)
}

const count = (evs: Ev[], type: string) => evs.filter(e => e.type === type).length
const types = (evs: Ev[]) => evs.map(e => e.type)

/** Writes one line to the FIFO (the CLI keeps it open read-write, so this never blocks). */
function sendLine(fifo: string, obj: object | string) {
  writeFileSync(fifo, (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n')
}

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'fnh-mx-'))
  const fifo = join(dir, 'in.fifo')
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
  return { events: join(dir, 'events.jsonl'), fifo }
}

let fake: ReturnType<typeof startScripted>
beforeAll(() => {
  fake = startScripted(700)
})
afterAll(() => fake.stop())

const tuiEnv = (configDir: string, extra: Record<string, string>) =>
  // The "full" profile exposes AskUserQuestion; local accounts default to the 7 basic tools.
  fakeEnv(fake.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full', FNHARNESS_LOCAL_LEAN: '0', ...extra })

describe.skipIf(!hasCli)('matrix event channel e2e', () => {
  test('typed prompt: session_start → ready → turn_start → turn_end → ready, with a contiguous seq', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events } = workdir()
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events }), cwd)
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      tui.line('di hola')
      const evs = await waitEvents(events, e => count(e, 'ready') >= 2 && count(e, 'turn_end') >= 1, 'turn end and ready')
      const flow = evs.filter(e => e.type !== 'entry')
      expect(types(flow).slice(0, 6)).toEqual(['session_start', 'mcp_settled', 'ready', 'turn_start', 'turn_end', 'ready'])
      expect(evs.map(e => e.seq)).toEqual(evs.map((_, i) => i + 1))
      expect(new Set(evs.map(e => e.session_id)).size).toBe(1)
      expect(evs.every(e => e.v === 2 && !Number.isNaN(Date.parse(e.ts)))).toBe(true)
      expect(flow[0]).toMatchObject({ cwd, resumed: false, model: FAKE_MODEL, caps: ['entries', 'mcp'] })
      expect(typeof flow[0]!.pid).toBe('number')
      expect(flow[1]).toMatchObject({ connected: 0, failed: 0, pending: 0 })
      expect(flow[3]).toMatchObject({ source: 'user' })
      expect(flow[4]).toMatchObject({ reason: 'completed' })
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('a prompt sent through the FIFO runs a turn; a second one queues behind it', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }), cwd)
    const before = fake.requests.length
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      sendLine(fifo, { type: 'prompt', id: 'p1', text: 'primer mensaje fifo' })
      sendLine(fifo, 'esto no es json')
      sendLine(fifo, { type: 'prompt', id: 'p2', text: 'segundo mensaje fifo' })
      const evs = await waitEvents(events, e => count(e, 'turn_end') >= 2 && count(e, 'ready') >= 2, 'two turns and ready', 45_000)
      expect(types(evs.filter(e => e.type !== 'entry'))).toEqual([
        'session_start',
        'mcp_settled',
        'ready',
        'input_accepted',
        // p2 arrives while p1 is being handed to the REPL: it waits in the channel's queue.
        'input_queued',
        'turn_start',
        'turn_end',
        'input_accepted',
        'turn_start',
        'turn_end',
        'ready',
      ])
      const flow = evs.filter(e => e.type !== 'entry')
      expect(flow[3]).toMatchObject({ id: 'p1', text_len: 'primer mensaje fifo'.length })
      expect(flow[4]).toMatchObject({ id: 'p2' })
      expect(flow[5]).toMatchObject({ source: 'user' })
      expect(flow[8]).toMatchObject({ source: 'queued' })
      const sent = JSON.stringify(fake.requests.slice(before))
      expect(sent).toContain('primer mensaje fifo')
      expect(sent).toContain('segundo mensaje fifo')
      expect(sent).not.toContain('esto no es json')
      // The terminal still works: the session was not taken down by the invalid line.
      expect(tui.text()).toContain('hola')
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('ask_user → ask_user_done answered through ask_answer; the model receives the choice', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }), cwd)
    const before = fake.requests.length
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      sendLine(fifo, { type: 'prompt', id: 'q1', text: 'PREGUNTA al usuario' })
      const asked = await waitEvents(events, evs => count(evs, 'ask_user') >= 1, 'ask_user')
      const ask = asked.find(e => e.type === 'ask_user')!
      expect(ask.tool_use_id).toBe('call_ask')
      expect(ask.questions).toEqual([
        {
          header: 'Tienda',
          question: '¿Dónde compro?',
          multiSelect: false,
          options: [
            { label: 'Mercadona', description: 'cerca' },
            { label: 'Dia', description: 'barato' },
          ],
        },
      ])
      // A turn is open while the dialog is up: no ready in between.
      expect(count(asked, 'ready')).toBe(1)
      sendLine(fifo, { type: 'ask_answer', tool_use_id: 'call_ask', selected: ['Dia'] })
      const evs = await waitEvents(events, e => count(e, 'ask_user_done') >= 1 && count(e, 'ready') >= 2, 'ask_user_done and ready', 45_000)
      const flow = evs.filter(e => e.type !== 'entry')
      expect(types(flow)).toEqual([
        'session_start',
        'mcp_settled',
        'ready',
        'input_accepted',
        'turn_start',
        'ask_user',
        'ask_user_done',
        'turn_end',
        'ready',
      ])
      expect(flow[6]).toMatchObject({ tool_use_id: 'call_ask', answered: true })
      const toolResult = fake.requests.slice(before).flatMap(r => r.messages).filter(m => m.role === 'tool').map(text).join('\n')
      expect(toolResult).toContain('"¿Dónde compro?"="Dia"')
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('interrupt over the FIFO ends the running turn as interrupted', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }), cwd)
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      sendLine(fifo, { type: 'prompt', id: 'i1', text: 'trabaja un rato' })
      await waitEvents(events, evs => count(evs, 'turn_start') >= 1, 'turn_start')
      sendLine(fifo, { type: 'interrupt' })
      const evs = await waitEvents(events, e => count(e, 'turn_end') >= 1 && count(e, 'ready') >= 2, 'interrupted turn and ready')
      expect(evs.find(e => e.type === 'turn_end')).toMatchObject({ reason: 'interrupted' })
      expect(types(evs).indexOf('ready', 3)).toBeGreaterThan(types(evs).indexOf('turn_end'))
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('/clear announces session_switch with the old and the new session id', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events } = workdir()
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events }), cwd)
    try {
      const first = await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      const sid = first[0]!.session_id
      tui.line('/clear')
      const evs = await waitEvents(events, e => count(e, 'session_switch') >= 1, 'session_switch')
      const sw = evs.find(e => e.type === 'session_switch')!
      expect(sw).toMatchObject({ old_session_id: sid, reason: 'clear' })
      expect(sw.new_session_id).not.toBe(sid)
      expect(sw.session_id).toBe(sw.new_session_id)
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('/clear keeps <config>/sessions/<pid>.json on the live session id (the bridge follows it)', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events } = workdir()
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events }), cwd)
    try {
      const first = await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      const pid = first.find(e => e.type === 'session_start')!.pid
      const pidFile = join(configDir, 'sessions', `${pid}.json`)
      // The pid file is written asynchronously; under load it can land after `ready`.
      for (const end = Date.now() + 5000; !existsSync(pidFile) && Date.now() < end; ) await Bun.sleep(100)
      expect(JSON.parse(readFileSync(pidFile, 'utf8')).sessionId).toBe(first[0]!.session_id)
      tui.line('/clear')
      const evs = await waitEvents(events, e => count(e, 'session_switch') >= 1, 'session_switch')
      const newId = evs.find(e => e.type === 'session_switch')!.new_session_id
      const end = Date.now() + 5000
      let seen = ''
      while (Date.now() < end && seen !== newId) {
        seen = JSON.parse(readFileSync(pidFile, 'utf8')).sessionId
        if (seen !== newId) await Bun.sleep(100)
      }
      expect(seen).toBe(newId)
    } finally {
      await tui.stop()
    }
  }, 60_000)

  test('headless -p: session_start, turn_start, turn_end, exit', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events } = workdir()
    const proc = Bun.spawn([CLI, '-p', 'di hola'], {
      cwd,
      env: tuiEnv(configDir, { FNHARNESS_EVENTS: events }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    await new Response(proc.stdout).text()
    await proc.exited
    const evs = readEvents(events)
    expect(types(evs)[0]).toBe('session_start')
    expect(types(evs).filter(t => t === 'turn_start' || t === 'turn_end')).toEqual(['turn_start', 'turn_end'])
    expect(types(evs).at(-1)).toBe('exit')
    expect(evs.at(-1)).toMatchObject({ code: 0 })
    expect(evs.map(e => e.seq)).toEqual(evs.map((_, i) => i + 1))
  }, 70_000)

  test('regression: without the variables nothing is written or read and the session behaves as before', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const env = tuiEnv(configDir, {})
    delete (env as Record<string, string | undefined>).FNHARNESS_EVENTS
    delete (env as Record<string, string | undefined>).FNHARNESS_INPUT
    const tui = startTui(env, cwd)
    try {
      await tui.waitFor('? for shortcuts', 30_000).catch(() => {})
      tui.line('di hola')
      await tui.waitFor('hola', 40_000)
      // A line left in a FIFO nobody told the CLI about is never consumed (nothing was opened).
      const before = fake.requests.length
      expect(existsSync(events)).toBe(false)
      expect(fake.requests.length).toBe(before)
    } finally {
      await tui.stop()
    }
    // And headless output is unchanged by the channel being off: no events file appears.
    const proc = Bun.spawn([CLI, '-p', 'di hola'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
    expect(await new Response(proc.stdout).text()).toContain('hola')
    await proc.exited
    expect(existsSync(events)).toBe(false)
    expect(fifo.length).toBeGreaterThan(0)
  }, 100_000)
})

// ── contract v2: entry, input_id, orden, mcp_settled, fork ───────────────

type Entry = Ev & { entry: Record<string, any>; input_id?: string; truncated?: boolean }
const entriesOf = (evs: Ev[]) => evs.filter(e => e.type === 'entry') as Entry[]
const blocks = (e: Entry): Array<Record<string, any>> => (Array.isArray(e.entry.message?.content) ? e.entry.message.content : [])
const hasBlock = (e: Entry, type: string, pred: (b: Record<string, any>) => boolean = () => true) =>
  blocks(e).some(b => b.type === type && pred(b))

/** The tool turn of the scripted model: a line of text, a Read call, then "gracias". */
function readNote(cwd: string) {
  const note = join(cwd, 'nota.txt')
  writeFileSync(note, 'contenido de la nota\n')
  return note
}

/** Checks the order the bridge relies on: the entries of the tool turn, all before its turn_end. */
function expectToolTurnEntries(evs: Ev[], fromIndex = 0) {
  const part = evs.slice(fromIndex)
  const at = (pred: (e: Entry) => boolean) => part.findIndex(e => e.type === 'entry' && pred(e as Entry))
  const iUser = at(e => e.entry.type === 'user' && e.input_id !== undefined)
  const iText = at(e => e.entry.type === 'assistant' && hasBlock(e, 'text', b => b.text === 'Voy a leer el fichero'))
  const iUse = at(e => e.entry.type === 'assistant' && hasBlock(e, 'tool_use', b => b.name === 'Read'))
  const iResult = at(e => e.entry.type === 'user' && hasBlock(e, 'tool_result', b => JSON.stringify(b.content).includes('contenido de la nota')))
  const iFinal = at(e => e.entry.type === 'assistant' && hasBlock(e, 'text', b => b.text === 'gracias'))
  // The first turn_end after the answer: a /clear before it is a turn of its own.
  const iEnd = part.findIndex((e, i) => e.type === 'turn_end' && i > iFinal)
  for (const [name, i] of Object.entries({ iUser, iText, iUse, iResult, iFinal, iEnd })) expect([name, i >= 0]).toEqual([name, true])
  expect(iUser).toBeLessThan(iUse)
  expect(iUse).toBeLessThan(iResult)
  expect(iResult).toBeLessThan(iFinal)
  expect(iFinal).toBeLessThan(iEnd)
  return { iUser, iText, iUse, iResult, iFinal, iEnd, part }
}

describe.skipIf(!hasCli)('matrix event channel v2 e2e', () => {
  test('a tool turn emits its entries before turn_end; the FIFO prompt carries input_id; entries match the transcript lines', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const note = readNote(cwd)
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }), cwd)
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      sendLine(fifo, { type: 'prompt', id: 'br-1', text: `HERRAMIENTA ${note}` })
      const evs = await waitEvents(events, e => count(e, 'turn_end') >= 1 && count(e, 'ready') >= 2, 'tool turn and ready', 60_000)
      const { part } = expectToolTurnEntries(evs)
      // input_id only on the entry of the FIFO prompt.
      expect(entriesOf(part).filter(e => e.input_id !== undefined).map(e => [e.entry.type, e.input_id])).toEqual([['user', 'br-1']])
      expect(entriesOf(part).find(e => e.input_id)!.entry.message.content).toContain('HERRAMIENTA')
      // The entries carry the session id of the event and the fields of the transcript line.
      const sid = evs[0]!.session_id
      for (const e of entriesOf(evs)) expect(e.session_id).toBe(sid)
      // The emitted object is the very line written to the transcript.
      const file = findTranscript(configDir, sid)
      expect(file).not.toBeNull()
      const end = Date.now() + 5000
      let lines: Array<Record<string, any>> = []
      while (Date.now() < end) {
        lines = readFileSync(file!, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
        if (entriesOf(evs).filter(e => ['user', 'assistant'].includes(e.entry.type)).every(e => lines.some(l => l.uuid === e.entry.uuid))) break
        await Bun.sleep(100)
      }
      for (const e of entriesOf(evs).filter(x => ['user', 'assistant'].includes(x.entry.type) && !x.truncated)) {
        expect(lines.find(l => l.uuid === e.entry.uuid)).toEqual(e.entry)
      }
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('after /clear the entries keep coming in the same file with the new session_id', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const note = readNote(cwd)
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }), cwd)
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      sendLine(fifo, { type: 'prompt', id: 'br-1', text: 'di hola' })
      const first = await waitEvents(events, e => count(e, 'turn_end') >= 1 && count(e, 'ready') >= 2, 'first turn')
      const oldSid = first[0]!.session_id
      tui.line('/clear')
      const cleared = await waitEvents(events, e => count(e, 'session_switch') >= 1 && count(e, 'ready') >= 3, 'session_switch and ready')
      const newSid = cleared.find(e => e.type === 'session_switch')!.new_session_id as string
      expect(newSid).not.toBe(oldSid)
      sendLine(fifo, { type: 'prompt', id: 'br-2', text: `HERRAMIENTA ${note}` })
      const evs = await waitEvents(events, e => count(e, 'turn_end') >= 2 && count(e, 'ready') >= 4, 'second turn', 60_000)
      const switchAt = evs.findIndex(e => e.type === 'session_switch')
      expectToolTurnEntries(evs, switchAt)
      const after = entriesOf(evs.slice(switchAt))
      expect(after.length).toBeGreaterThan(0)
      expect(after.every(e => e.session_id === newSid)).toBe(true)
      expect(after.find(e => e.input_id)).toMatchObject({ input_id: 'br-2' })
      // Before the switch the entries were the first session's.
      expect(entriesOf(evs.slice(0, switchAt)).every(e => e.session_id === oldSid)).toBe(true)
      expect(entriesOf(evs.slice(0, switchAt)).find(e => e.input_id)).toMatchObject({ input_id: 'br-1' })
      expect(new Set(evs.map(e => e.seq)).size).toBe(evs.length)
    } finally {
      await tui.stop()
    }
  }, 120_000)

  test('a long turn (over 30 s) records turn_duration and it goes before turn_end', async () => {
    const slow = startScripted(16_000)
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const note = readNote(cwd)
    const env = fakeEnv(slow.baseUrl, configDir, { FNHARNESS_CONTEXT_PROFILE: 'full', FNHARNESS_LOCAL_LEAN: '0', FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo })
    const tui = startTui(env, cwd)
    try {
      await waitEvents(events, evs => count(evs, 'ready') >= 1, 'first ready')
      sendLine(fifo, { type: 'prompt', id: 'br-9', text: `HERRAMIENTA ${note}` })
      const evs = await waitEvents(events, e => count(e, 'turn_end') >= 1 && count(e, 'ready') >= 2, 'long turn and ready', 90_000)
      const { part, iFinal, iEnd } = expectToolTurnEntries(evs)
      const iDuration = part.findIndex(e => e.type === 'entry' && (e as Entry).entry.type === 'system' && (e as Entry).entry.subtype === 'turn_duration')
      expect(iDuration).toBeGreaterThan(iFinal)
      expect(iDuration).toBeLessThan(iEnd)
      expect((part[iDuration] as Entry).entry.durationMs).toBeGreaterThan(30_000)
      // ready comes after turn_end, never before the footer of the turn.
      expect(part.findIndex((e, i) => e.type === 'ready' && i > iEnd)).toBeGreaterThan(iEnd)
    } finally {
      await tui.stop()
      slow.stop()
    }
  }, 150_000)

  test('mcp_settled comes before the first ready with a slow MCP server; a prompt sent meanwhile waits', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const server = { command: process.execPath, args: [join(import.meta.dir, 'fixtures', 'mcp_stdio_server.ts')], env: { FIX_TOOLS: 'lento', FIX_INIT_DELAY_MS: '3000' } }
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { lento: server } }))
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }), cwd)
    try {
      await waitEvents(events, evs => count(evs, 'session_start') >= 1, 'session_start')
      sendLine(fifo, { type: 'prompt', id: 'br-1', text: 'di hola' })
      const evs = await waitEvents(events, e => count(e, 'turn_end') >= 1 && count(e, 'ready') >= 1, 'turn after mcp', 60_000)
      const flow = evs.filter(e => e.type !== 'entry')
      expect(types(flow).slice(0, 5)).toEqual(['session_start', 'input_queued', 'mcp_settled', 'input_accepted', 'turn_start'])
      expect(flow[0]).toMatchObject({ caps: ['entries', 'mcp'] })
      expect(flow[2]).toMatchObject({ connected: 1, failed: 0, pending: 0 })
      // The queued prompt only ran after the MCP tools were there; the first ready is after the turn.
      expect(types(flow).indexOf('ready')).toBeGreaterThan(types(flow).indexOf('turn_end'))
      expect(Date.parse(flow[2]!.ts) - Date.parse(flow[0]!.ts)).toBeGreaterThan(2000)
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('a failing MCP server counts as failed and does not hold the channel', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events } = workdir()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { roto: { command: '/nonexistent/mcp-server-xyz', args: [] } } }))
    const tui = startTui(tuiEnv(configDir, { FNHARNESS_EVENTS: events }), cwd)
    try {
      const evs = await waitEvents(events, e => count(e, 'ready') >= 1, 'ready', 60_000)
      expect(types(evs).slice(0, 3)).toEqual(['session_start', 'mcp_settled', 'ready'])
      expect(evs[1]).toMatchObject({ connected: 0, failed: 1, pending: 0 })
    } finally {
      await tui.stop()
    }
  }, 90_000)

  test('--fork-session does not inherit FNHARNESS_EVENTS or FNHARNESS_INPUT (a plain --continue still writes)', async () => {
    const { configDir, cwd } = makeSandbox()
    const { events, fifo } = workdir()
    const base = tuiEnv(configDir, {})
    delete (base as Record<string, string | undefined>).FNHARNESS_EVENTS
    delete (base as Record<string, string | undefined>).FNHARNESS_INPUT
    const run = async (args: string[], env: Record<string, string | undefined>) => {
      const proc = Bun.spawn([CLI, '-p', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return out
    }
    // A session to continue from.
    expect(await run(['di hola'], base)).toContain('hola')
    const withChannel = { ...base, FNHARNESS_EVENTS: events, FNHARNESS_INPUT: fifo }
    expect(await run(['--continue', '--fork-session', 'di hola otra vez'], withChannel)).toContain('hola')
    expect(existsSync(events)).toBe(false)
    // Control: without --fork-session the same environment does write events (and entries).
    expect(await run(['--continue', 'di hola otra vez'], withChannel)).toContain('hola')
    const evs = readEvents(events)
    expect(types(evs)[0]).toBe('session_start')
    expect(count(evs, 'entry')).toBeGreaterThan(0)
  }, 150_000)
})
