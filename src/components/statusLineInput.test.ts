/**
 * Viewing a subagent, the status line input describes THAT agent field by
 * field; outside the view, the session. A zcode-like agent viewed from a
 * Claude session must leave no Claude/session data in the input.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetAccountRoutingForTesting } from '../services/api/accountRouting.js'
import type { Message } from '../types/message.js'
import {
  agentTotalsFromMessages,
  buildStatusLineCommandInput,
  selectStatusLineView,
  viewedAgentFromTask,
  type SessionSources,
  type ViewedAgent,
} from './statusLineInput.js'

const assistant = (id: string, model: string, usage: Record<string, number>): Message =>
  ({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'hola' }], usage } }) as unknown as Message

const SESSION_MODEL = 'claude-sonnet-4-6'
const sessionMessages = [assistant('s1', SESSION_MODEL, { input_tokens: 150_000, output_tokens: 777, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })]
const sessionSources: SessionSources = {
  cost: () => ({ total_cost_usd: 12.34, total_duration_ms: 987654, total_api_duration_ms: 55555, total_lines_added: 4321, total_lines_removed: 1234 }),
  inputTokens: () => 8_888_888,
  outputTokens: () => 7_777_777,
}

const zAgent: ViewedAgent = {
  id: 'agent-z-1',
  name: 'lab-operator',
  description: 'Mapa mejoras',
  model: 'acctz:glm-flash',
  messages: [
    assistant('z1', 'glm-flash', { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    // Split record of the same API response: counted once.
    assistant('z1', 'glm-flash', { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    assistant('z2', 'glm-flash', { input_tokens: 2000, output_tokens: 70, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
  ],
  startTime: 1_000,
  endTime: 4_000,
}

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  ;(globalThis as any).MACRO ??= { VERSION: '0.0.0-test' }
  for (const k of ['CLAUDE_CONFIG_DIR', 'FNHARNESS_ACCOUNT', 'ANTHROPIC_API_KEY', 'FNHARNESS_DISABLE_MODELS_FETCH']) saved[k] = process.env[k]
  const dir = mkdtempSync(join(tmpdir(), 'fnh-sl-'))
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify({
      accounts: {
        acctz: { provider: 'custom', label: 'Cuenta Z', baseUrl: 'https://api.z.example/v1', model: 'glm-big', smallModel: 'glm-flash', apiKey: 'k', contextWindow: 64000 },
      },
    }),
  )
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.FNHARNESS_DISABLE_MODELS_FETCH = '1'
  delete process.env.FNHARNESS_ACCOUNT
  resetAccountRoutingForTesting()
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetAccountRoutingForTesting()
})

const build = (viewed: ViewedAgent | undefined) =>
  buildStatusLineCommandInput({
    view: selectStatusLineView({ mainLoopModel: SESSION_MODEL, messages: sessionMessages }, viewed),
    permissionMode: 'default',
    exceeds200kTokens: false,
    settings: {} as never,
    addedDirs: [],
    perfil: { name: 'sesion-perfil', modified: false },
    session: sessionSources,
    now: 10_000,
  }) as any

describe('selectStatusLineView / viewedAgentFromTask (pure)', () => {
  test('no viewed agent: the session; a viewed agent: its model and messages', () => {
    expect(selectStatusLineView({ mainLoopModel: 'm', messages: sessionMessages }, undefined)).toEqual({ scope: 'session', mainLoopModel: 'm', messages: sessionMessages })
    const v = selectStatusLineView({ mainLoopModel: 'm', messages: sessionMessages }, zAgent)
    expect(v.scope).toBe('agent')
    expect(v.mainLoopModel).toBe('acctz:glm-flash')
    expect(v.messages).toBe(zAgent.messages)
    // An agent without its own model inherits the session's, with its own messages.
    const inherit = selectStatusLineView({ mainLoopModel: 'm', messages: sessionMessages }, { ...zAgent, model: undefined })
    expect(inherit.mainLoopModel).toBe('m')
    expect(inherit.messages).toBe(zAgent.messages)
  })

  test('tasks: local agents and teammates map to a ViewedAgent, other tasks do not', () => {
    const local = viewedAgentFromTask({ type: 'local_agent', id: 't1', agentId: 'a1', agentType: 'Explore', description: 'd', model: 'acctz:x', messages: [], startTime: 5 })
    expect(local).toMatchObject({ id: 'a1', name: 'Explore', description: 'd', model: 'acctz:x', startTime: 5 })
    const mate = viewedAgentFromTask({ type: 'in_process_teammate', id: 't2', identity: { agentId: 'r@team', agentName: 'researcher' }, messages: [], startTime: 1 })
    expect(mate).toMatchObject({ id: 'r@team', name: 'researcher' })
    expect(viewedAgentFromTask({ type: 'local_bash', id: 'b' })).toBeUndefined()
    expect(viewedAgentFromTask(undefined)).toBeUndefined()
  })

  test('agent totals come from its own messages, split records once', () => {
    const t = agentTotalsFromMessages('acctz:glm-flash', zAgent, 10_000, () => 0.5)
    expect(t.inputTokens).toBe(3000)
    expect(t.outputTokens).toBe(120)
    expect(t.cost.total_cost_usd).toBe(1)
    expect(t.cost.total_duration_ms).toBe(3000)
  })
})

describe('buildStatusLineCommandInput: viewed zcode-like agent vs session', () => {
  test('session view: session model, account, cost and context', () => {
    const s = build(undefined)
    expect(s.model.id).toBe(SESSION_MODEL)
    expect(s.fnharness.account.id).toBe('claude')
    expect(s.fnharness.account.provider).toBeNull()
    expect(s.cost.total_cost_usd).toBe(12.34)
    expect(s.context_window.total_input_tokens).toBe(8_888_888)
    expect(s.context_window.current_usage.input_tokens).toBe(150_000)
    expect(s.agent).toBeUndefined()
  })

  test('agent view: every field is the agent and its account, none of the session', () => {
    const a = build(zAgent)
    // model
    expect(a.model.id).toBe('glm-flash')
    // account: id, label, provider, base URL; no OAuth holder
    expect(a.fnharness.account.id).toBe('acctz')
    expect(a.fnharness.account.label).not.toBe('Claude')
    expect(a.fnharness.account.provider).toBe('custom')
    expect(a.fnharness.account.base_url).toBe('https://api.z.example/v1')
    expect(a.fnharness.account.model).toBe('glm-flash')
    expect(a.fnharness.account.email).toBeNull()
    // context: the agent's last usage against the agent account's window
    expect(a.context_window.current_usage.input_tokens).toBe(2000)
    expect(a.context_window.context_window_size).toBe(a.fnharness.context.window)
    expect(a.fnharness.context.source).not.toBe('claude')
    expect(a.context_window.total_input_tokens).toBe(3000)
    expect(a.context_window.total_output_tokens).toBe(120)
    // cost: the agent's, not the session's
    expect(a.cost.total_cost_usd).not.toBe(12.34)
    expect(a.cost.total_duration_ms).toBe(3000)
    expect(a.cost.total_lines_added).toBe(0)
    // limits: an OpenAI-compatible account has no 5h/7d windows
    expect(a.rate_limits).toBeUndefined()
    // session-only bits are not shown as the agent's
    expect(a.fnharness.profile).toBeNull()
    expect(a.fnharness.speed).toBeNull()
    // the agent identity
    expect(a.agent).toMatchObject({ name: 'lab-operator', id: 'agent-z-1', viewed: true, description: 'Mapa mejoras' })
    expect(a.agent_id).toBe('agent-z-1')
    // and nothing of the session leaks anywhere in the JSON
    const json = JSON.stringify(a)
    for (const leak of [SESSION_MODEL, '12.34', '8888888', '7777777', '987654', '4321', '150000', 'sesion-perfil']) {
      expect(json).not.toContain(leak)
    }
  })

  test('leaving the view goes back to the session', () => {
    build(zAgent)
    const s = build(undefined)
    expect(s.fnharness.account.id).toBe('claude')
    expect(s.model.id).toBe(SESSION_MODEL)
  })
})
