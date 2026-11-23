import { beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import type { AppState } from '../../state/AppState.js'
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../utils/messageQueueManager.js'
import { flushTaskOutput } from '../../utils/task/diskOutput.js'
import {
  DEFAULT_TOOL_AUTO_BACKGROUND_MS,
  getToolAutoBackgroundMs,
  isToolBackgroundable,
} from './backgroundable.js'
import {
  backgroundAllLocalToolTasks,
  BACKGROUND_TOOL_RESULT_PREFIX,
  formatToolProgressLine,
  hasForegroundLocalToolTasks,
  isLocalToolTask,
  killLocalToolTask,
  type LocalToolTaskState,
} from './LocalToolTask.js'
import {
  buildBackgroundedToolResultText,
  runBackgroundableToolCall,
  type BackgroundableCallContext,
} from './runBackgroundable.js'

function makeStore() {
  let state = { tasks: {} } as unknown as AppState
  return {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A fake tool call that resolves after `ms`, rejects on abort, and emits one progress event. */
function fakeCall(ms: number, value = 'ok') {
  let seen: AbortSignal | undefined
  const call = ({ abortController, recordProgress }: BackgroundableCallContext) =>
    new Promise<string>((resolve, reject) => {
      seen = abortController.signal
      recordProgress({ type: 'mcp_progress', status: 'progress', progress: 1, total: 2, progressMessage: 'half' })
      const t = setTimeout(() => resolve(value), ms)
      abortController.signal.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      })
    })
  return { call, signal: () => seen }
}

function onlyTask(store: ReturnType<typeof makeStore>): LocalToolTaskState | undefined {
  return Object.values(store.getAppState().tasks).find(isLocalToolTask)
}

async function waitFor(pred: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await sleep(5)
  }
}

function baseOpts(store: ReturnType<typeof makeStore>, parent = new AbortController()) {
  return {
    toolName: 'mcp__srv__slow',
    description: 'srv - slow (MCP): demo',
    toolUseId: 'toolu_test',
    parentAbortController: parent,
    getAppState: store.getAppState,
    setAppState: store.setAppState,
    formatResult: (r: string) => `RESULT:${r}`,
    autoBackgroundMs: 0,
    registerDelayMs: 10,
  }
}

beforeEach(() => {
  clearCommandQueue()
})

describe('isToolBackgroundable', () => {
  test('MCP and web tools are backgroundable by default', () => {
    expect(isToolBackgroundable({ name: 'mcp__srv__tool' }, {})).toBe(true)
    expect(isToolBackgroundable({ name: 'WebFetch' }, {})).toBe(true)
  })
  test('excluded tools are not', () => {
    for (const name of ['Bash', 'Agent', 'Read', 'Edit', 'Grep', 'TaskOutput', 'Monitor', 'Skill', 'AskUserQuestion']) {
      expect(isToolBackgroundable({ name }, {})).toBe(false)
    }
  })
  test('explicit flag and interaction override the list', () => {
    expect(isToolBackgroundable({ name: 'Read', backgroundable: true }, {})).toBe(true)
    expect(isToolBackgroundable({ name: 'mcp__a__b', backgroundable: false }, {})).toBe(false)
    expect(isToolBackgroundable({ name: 'X', requiresUserInteraction: () => true }, {})).toBe(false)
  })
  test('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS disables everything', () => {
    expect(isToolBackgroundable({ name: 'mcp__a__b' }, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' })).toBe(false)
  })
})

describe('getToolAutoBackgroundMs', () => {
  test('default, explicit, zero and garbage', () => {
    expect(getToolAutoBackgroundMs({})).toBe(DEFAULT_TOOL_AUTO_BACKGROUND_MS)
    expect(getToolAutoBackgroundMs({ FNHARNESS_TOOL_AUTO_BACKGROUND_MS: '5000' })).toBe(5000)
    expect(getToolAutoBackgroundMs({ FNHARNESS_TOOL_AUTO_BACKGROUND_MS: '0' })).toBe(0)
    expect(getToolAutoBackgroundMs({ FNHARNESS_TOOL_AUTO_BACKGROUND_MS: 'abc' })).toBe(DEFAULT_TOOL_AUTO_BACKGROUND_MS)
  })
})

describe('formatToolProgressLine', () => {
  test('MCP progress is compact', () => {
    expect(formatToolProgressLine({ type: 'mcp_progress', status: 'progress', progress: 3, total: 10, progressMessage: 'step' })).toBe('[mcp progress] 3/10 step')
  })
  test('other payloads are JSON', () => {
    expect(formatToolProgressLine({ type: 'x', n: 1 })).toBe('[progress] {"type":"x","n":1}')
  })
})

describe('runBackgroundableToolCall', () => {
  test('fast call completes normally and leaves no task behind', async () => {
    const store = makeStore()
    const { call } = fakeCall(1)
    const out = await runBackgroundableToolCall({ ...baseOpts(store), registerDelayMs: 200, call })
    expect(out).toEqual({ kind: 'completed', result: 'ok' })
    expect(onlyTask(store)).toBeUndefined()
    expect(getCommandQueueSnapshot().length).toBe(0)
  })

  test('slow call that finishes in the foreground unregisters its task', async () => {
    const store = makeStore()
    const { call } = fakeCall(60)
    const out = await runBackgroundableToolCall({ ...baseOpts(store), call })
    expect(out.kind).toBe('completed')
    expect(onlyTask(store)).toBeUndefined()
  })

  test('Ctrl+B (backgroundAll) backgrounds, then completes with a notification', async () => {
    const store = makeStore()
    const { call } = fakeCall(150, 'done!')
    const p = runBackgroundableToolCall({ ...baseOpts(store), call })
    await waitFor(() => hasForegroundLocalToolTasks(store.getAppState()))
    backgroundAllLocalToolTasks(store.getAppState, store.setAppState)
    const out = await p
    expect(out.kind).toBe('backgrounded')
    if (out.kind !== 'backgrounded') return
    expect(out.reason).toBe('user')
    expect(onlyTask(store)?.isBackgrounded).toBe(true)
    const text = buildBackgroundedToolResultText(out, 0)
    expect(text.startsWith(BACKGROUND_TOOL_RESULT_PREFIX)).toBe(true)
    expect(text).toContain(out.taskId)
    expect(text).toContain(out.outputPath)

    await waitFor(() => onlyTask(store)?.status === 'completed')
    const task = onlyTask(store)!
    expect(task.notified).toBe(true)
    const queued = getCommandQueueSnapshot()
    expect(queued.length).toBe(1)
    expect(String(queued[0]!.value)).toContain(`<task-id>${out.taskId}</task-id>`)
    expect(String(queued[0]!.value)).toContain('<status>completed</status>')
    expect(String(queued[0]!.value)).toContain('RESULT:done!')
    await flushTaskOutput(out.taskId)
    const file = await readFile(out.outputPath, 'utf8')
    expect(file).toContain('[mcp progress] 1/2 half')
    expect(file).toContain('RESULT:done!')
  })

  test('auto-background fires after the threshold', async () => {
    const store = makeStore()
    const { call } = fakeCall(200)
    const out = await runBackgroundableToolCall({ ...baseOpts(store), autoBackgroundMs: 30, call })
    expect(out.kind).toBe('backgrounded')
    if (out.kind === 'backgrounded') expect(out.reason).toBe('auto')
    await waitFor(() => onlyTask(store)?.status === 'completed')
  })

  test('turn abort kills the call while it is in the foreground', async () => {
    const store = makeStore()
    const parent = new AbortController()
    const { call, signal } = fakeCall(500)
    const p = runBackgroundableToolCall({ ...baseOpts(store, parent), call })
    await sleep(20)
    parent.abort('interrupt')
    await expect(p).rejects.toThrow('aborted')
    expect(signal()?.aborted).toBe(true)
    expect(onlyTask(store)).toBeUndefined()
  })

  test('turn abort does not reach a backgrounded call; TaskStop does', async () => {
    const store = makeStore()
    const parent = new AbortController()
    const { call, signal } = fakeCall(2000)
    const out = await runBackgroundableToolCall({ ...baseOpts(store, parent), autoBackgroundMs: 20, call })
    expect(out.kind).toBe('backgrounded')
    parent.abort('interrupt')
    await sleep(10)
    expect(signal()?.aborted).toBe(false)
    killLocalToolTask(onlyTask(store)!.id, store.setAppState)
    expect(signal()?.aborted).toBe(true)
    expect(onlyTask(store)?.status).toBe('killed')
    await sleep(10)
    // The rejection after the kill must not overwrite the killed state.
    expect(onlyTask(store)?.status).toBe('killed')
    const queued = getCommandQueueSnapshot()
    expect(queued.length).toBe(1)
    expect(String(queued[0]!.value)).toContain('<status>killed</status>')
  })

  test('stopping a foreground task returns kind stopped without a notification', async () => {
    const store = makeStore()
    const { call } = fakeCall(2000)
    const p = runBackgroundableToolCall({ ...baseOpts(store), call })
    await waitFor(() => onlyTask(store) !== undefined)
    killLocalToolTask(onlyTask(store)!.id, store.setAppState)
    const out = await p
    expect(out.kind).toBe('stopped')
    expect(getCommandQueueSnapshot().length).toBe(0)
  })

  test('a backgrounded call that rejects is marked failed', async () => {
    const store = makeStore()
    const call = () => sleep(80).then(() => Promise.reject(new Error('boom')))
    const out = await runBackgroundableToolCall({ ...baseOpts(store), autoBackgroundMs: 20, call })
    expect(out.kind).toBe('backgrounded')
    await waitFor(() => onlyTask(store)?.status === 'failed')
    expect(String(getCommandQueueSnapshot()[0]!.value)).toContain('boom')
  })
})
