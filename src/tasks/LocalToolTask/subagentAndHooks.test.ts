import { beforeEach, describe, expect, test } from 'bun:test'
import { collectSubagentBackgroundWork } from '../../query/subagentBackgroundWait.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import {
  clearCommandQueue,
  enqueuePendingNotification,
  getCommandQueueSnapshot,
} from '../../utils/messageQueueManager.js'
import {
  DEFAULT_SUBAGENT_BG_WAIT_MS,
  getSubagentBgWaitMs,
  waitForAgentBackgroundTasks,
} from './agentBackgroundWait.js'
import {
  buildDeferredHooksSection,
  collectDeferredHooksSection,
  DEFERRED_HOOKS_SECTION_TITLE,
  formatDeferredHookLines,
} from './deferredHooks.js'
import {
  backgroundAllLocalToolTasks,
  hasForegroundLocalToolTasks,
  isLocalToolTask,
  isLocalToolTaskNotification,
  killLocalToolTasksForAgent,
  type LocalToolTaskState,
} from './LocalToolTask.js'
import {
  runBackgroundableToolCall,
  type BackgroundableCallContext,
} from './runBackgroundable.js'

const AGENT = 'a-sub-1' as AgentId

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

async function waitFor(pred: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await sleep(5)
  }
}

/** Resolves after `ms` (or rejects with `fail`), rejects on abort. */
function fakeCall(ms: number, value = 'ok', fail?: string) {
  return ({ abortController }: BackgroundableCallContext) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(
        () => (fail ? reject(new Error(fail)) : resolve(value)),
        ms,
      )
      abortController.signal.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      })
    })
}

function onlyTask(store: ReturnType<typeof makeStore>) {
  return Object.values(store.getAppState().tasks).find(isLocalToolTask) as
    | LocalToolTaskState
    | undefined
}

function opts(store: ReturnType<typeof makeStore>, extra: Record<string, unknown> = {}) {
  return {
    toolName: 'mcp__srv__slow',
    description: 'slow call',
    toolUseId: 'toolu_x',
    parentAbortController: new AbortController(),
    getAppState: store.getAppState,
    setAppState: store.setAppState,
    formatResult: (r: string) => `RESULT:${r}`,
    autoBackgroundMs: 0,
    registerDelayMs: 5,
    ...extra,
  }
}

beforeEach(() => {
  clearCommandQueue()
})

describe('subagent background tool calls', () => {
  test('task and notification carry the agentId; Ctrl+B leaves them alone', async () => {
    const store = makeStore()
    const p = runBackgroundableToolCall({
      ...opts(store, { agentId: AGENT, autoBackgroundMs: 40 }),
      call: fakeCall(120, 'sub'),
    })
    await waitFor(() => onlyTask(store) !== undefined)
    // A subagent call is not a Ctrl+B target.
    expect(hasForegroundLocalToolTasks(store.getAppState())).toBe(false)
    backgroundAllLocalToolTasks(store.getAppState, store.setAppState)
    expect(onlyTask(store)?.isBackgrounded).toBe(false)

    const out = await p
    expect(out.kind).toBe('backgrounded') // auto-background still applies
    expect(onlyTask(store)?.agentId).toBe(AGENT)
    await waitFor(() => onlyTask(store)?.status === 'completed')
    const queued = getCommandQueueSnapshot()
    expect(queued.length).toBe(1)
    expect(queued[0]!.agentId).toBe(AGENT)
    expect(isLocalToolTaskNotification(queued[0]!)).toBe(true)
    expect(String(queued[0]!.value)).toContain('RESULT:sub')
  })

  test('the end-of-turn wait blocks until the task finishes, then returns its notification', async () => {
    const store = makeStore()
    await runBackgroundableToolCall({
      ...opts(store, { agentId: AGENT, autoBackgroundMs: 10 }),
      call: fakeCall(150, 'late'),
    })
    expect(onlyTask(store)?.status).toBe('running')
    const started = Date.now()
    const work = await collectSubagentBackgroundWork({
      agentId: AGENT,
      getAppState: store.getAppState,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
    expect(onlyTask(store)?.status).toBe('completed')
    expect(work).not.toBeNull()
    expect(work!.consumed.length).toBe(1)
    expect(work!.messages.length).toBe(1)
    const att = work!.messages[0]!.attachment as { type: string; prompt: unknown }
    expect(att.type).toBe('queued_command')
    expect(String(att.prompt)).toContain('RESULT:late')
  })

  test('the wait respects the cap and leaves the task running', async () => {
    const store = makeStore()
    await runBackgroundableToolCall({
      ...opts(store, { agentId: AGENT, autoBackgroundMs: 10 }),
      call: fakeCall(2_000),
    })
    const r = await waitForAgentBackgroundTasks({
      agentId: AGENT,
      getAppState: store.getAppState,
      timeoutMs: 60,
      pollMs: 10,
    })
    expect(r.timedOut).toBe(true)
    expect(r.waitedFor.length).toBe(1)
    expect(r.stillRunning.length).toBe(1)
    // Nothing completed yet: no follow-up turn.
    const work = await collectSubagentBackgroundWork({
      agentId: AGENT,
      getAppState: store.getAppState,
      signal: new AbortController().signal,
      deadline: Date.now() - 1,
    })
    expect(work).toBeNull()
    killLocalToolTasksForAgent(AGENT, store.getAppState, store.setAppState)
  })

  test('the wait returns early on abort', async () => {
    const store = makeStore()
    await runBackgroundableToolCall({
      ...opts(store, { agentId: AGENT, autoBackgroundMs: 10 }),
      call: fakeCall(2_000),
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    const r = await waitForAgentBackgroundTasks({
      agentId: AGENT,
      getAppState: store.getAppState,
      timeoutMs: 5_000,
      signal: ac.signal,
      pollMs: 10,
    })
    expect(r.aborted).toBe(true)
    killLocalToolTasksForAgent(AGENT, store.getAppState, store.setAppState)
  })

  test('no wait and no follow-up when the agent has no background work', async () => {
    const store = makeStore()
    // Someone else's notification must not be picked up.
    enqueuePendingNotification({
      value: '<task-notification><task-type>local_tool</task-type></task-notification>',
      mode: 'task-notification',
      agentId: 'other' as AgentId,
    })
    const work = await collectSubagentBackgroundWork({
      agentId: AGENT,
      getAppState: store.getAppState,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    })
    expect(work).toBeNull()
  })

  test('killLocalToolTasksForAgent stops only that agent and purges its notifications', async () => {
    const store = makeStore()
    await runBackgroundableToolCall({
      ...opts(store, { agentId: AGENT, autoBackgroundMs: 10 }),
      call: fakeCall(2_000),
    })
    await runBackgroundableToolCall({
      ...opts(store, { agentId: 'a-other' as AgentId, autoBackgroundMs: 10 }),
      call: fakeCall(2_000),
    })
    killLocalToolTasksForAgent(AGENT, store.getAppState, store.setAppState)
    const tasks = Object.values(store.getAppState().tasks).filter(isLocalToolTask)
    expect(tasks.find(t => t.agentId === AGENT)?.status).toBe('killed')
    expect(tasks.find(t => t.agentId === 'a-other')?.status).toBe('running')
    expect(getCommandQueueSnapshot().some(c => c.agentId === AGENT)).toBe(false)
    killLocalToolTasksForAgent('a-other' as AgentId, store.getAppState, store.setAppState)
  })

  test('getSubagentBgWaitMs parses the env', () => {
    expect(getSubagentBgWaitMs({})).toBe(DEFAULT_SUBAGENT_BG_WAIT_MS)
    expect(getSubagentBgWaitMs({ FNHARNESS_SUBAGENT_BG_WAIT_MS: '1500' })).toBe(1500)
    expect(getSubagentBgWaitMs({ FNHARNESS_SUBAGENT_BG_WAIT_MS: '0' })).toBe(0)
    expect(getSubagentBgWaitMs({ FNHARNESS_SUBAGENT_BG_WAIT_MS: 'x' })).toBe(
      DEFAULT_SUBAGENT_BG_WAIT_MS,
    )
  })
})

describe('deferred PostToolUse hooks', () => {
  test('run once with the real result and their output lands in the notification', async () => {
    const store = makeStore()
    const calls: unknown[] = []
    const out = await runBackgroundableToolCall({
      ...opts(store, { autoBackgroundMs: 10 }),
      call: fakeCall(60, 'real'),
      afterBackgroundSettled: async settled => {
        calls.push(settled)
        return '[PostToolUse:x] additional context: checked'
      },
    })
    expect(out.kind).toBe('backgrounded')
    await waitFor(() => onlyTask(store)?.status === 'completed')
    expect(calls).toEqual([{ status: 'completed', result: 'real' }])
    const value = String(getCommandQueueSnapshot()[0]!.value)
    expect(value).toContain('RESULT:real')
    expect(value).toContain('additional context: checked')
  })

  test('a failed call gets the failure variant', async () => {
    const store = makeStore()
    const calls: Array<{ status: string }> = []
    await runBackgroundableToolCall({
      ...opts(store, { autoBackgroundMs: 10 }),
      call: fakeCall(40, '', 'boom'),
      afterBackgroundSettled: async settled => {
        calls.push(settled)
        return undefined
      },
    })
    await waitFor(() => onlyTask(store)?.status === 'failed')
    expect(calls.length).toBe(1)
    expect(calls[0]!.status).toBe('failed')
  })

  test('a throwing hook does not break the notification', async () => {
    const store = makeStore()
    await runBackgroundableToolCall({
      ...opts(store, { autoBackgroundMs: 10 }),
      call: fakeCall(40, 'still'),
      afterBackgroundSettled: async () => {
        throw new Error('hook exploded')
      },
    })
    await waitFor(() => onlyTask(store)?.status === 'completed')
    const value = String(getCommandQueueSnapshot()[0]!.value)
    expect(value).toContain('RESULT:still')
    expect(value).toContain('hook exploded')
  })

  test('not run for calls that finish in the foreground or are stopped', async () => {
    const store = makeStore()
    let n = 0
    const hook = async () => {
      n++
      return undefined
    }
    const fg = await runBackgroundableToolCall({
      ...opts(store),
      call: fakeCall(5, 'fast'),
      afterBackgroundSettled: hook,
    })
    expect(fg.kind).toBe('completed')
    const bg = await runBackgroundableToolCall({
      ...opts(store, { autoBackgroundMs: 10 }),
      call: fakeCall(2_000),
      afterBackgroundSettled: hook,
    })
    expect(bg.kind).toBe('backgrounded')
    if (bg.kind !== 'backgrounded') return
    const { killLocalToolTask } = await import('./LocalToolTask.js')
    killLocalToolTask(bg.taskId, store.setAppState)
    await sleep(30)
    expect(n).toBe(0)
  })

  test('collectDeferredHooksSection formats hook output and tolerates a failing generator', async () => {
    const att = (attachment: Record<string, unknown>) => ({
      message: { type: 'attachment', attachment },
    })
    const section = await collectDeferredHooksSection('PostToolUse', async function* () {
      yield att({ type: 'hook_additional_context', content: ['ctx A'], hookName: 'PostToolUse:X' })
      yield att({
        type: 'hook_blocking_error',
        hookName: 'PostToolUse:X',
        blockingError: { blockingError: 'nope', command: 'c' },
      })
      yield att({ type: 'hook_success', content: 'ignored', hookName: 'PostToolUse:X' })
      throw new Error('generator died')
    })
    expect(section).toContain(DEFERRED_HOOKS_SECTION_TITLE)
    expect(section).toContain('additional context: ctx A')
    expect(section).toContain('blocking error: nope')
    expect(section).not.toContain('ignored')
    expect(section).toContain('generator died')
    expect(buildDeferredHooksSection('PostToolUse', [])).toBeUndefined()
    expect(formatDeferredHookLines([{ updatedMCPToolOutput: 1 }])).toEqual([])
  })
})
