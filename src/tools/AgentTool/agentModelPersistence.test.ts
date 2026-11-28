/**
 * A subagent launched as `cuenta:modelo` must resume on the same account:
 * the canonical model is persisted in its metadata and reused by the resume
 * (bug seen live: a zcode agent resumed with SendMessage answered from
 * Anthropic because resume passed `model: undefined`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetAccountRoutingForTesting } from '../../services/api/accountRouting.js'
import { asAgentId } from '../../types/ids.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { readAgentMetadata, writeAgentMetadata } from '../../utils/sessionStorage.js'
import { persistableAgentModel, resumeAgentModel } from './agentModelPersistence.js'

const store = {
  accounts: {
    acctz: { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'big-z', smallModel: 'small-z' },
  },
}
const deps = { env: {}, store, currentAccount: 'claude' } as never
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ['CLAUDE_CONFIG_DIR', 'FNHARNESS_ACCOUNT', 'CLAUDE_CODE_SUBAGENT_MODEL']) saved[k] = process.env[k]
  const dir = mkdtempSync(join(tmpdir(), 'fnh-resume-'))
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify(store))
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.FNHARNESS_ACCOUNT
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  resetAccountRoutingForTesting()
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetAccountRoutingForTesting()
})

describe('persistableAgentModel', () => {
  test('only a routed cuenta:modelo is persisted', () => {
    expect(persistableAgentModel('acctz:glm-flash', deps)).toBe('acctz:glm-flash')
    expect(persistableAgentModel('claude:claude-haiku-x', deps)).toBe('claude:claude-haiku-x')
    expect(persistableAgentModel('claude-sonnet-x', deps)).toBeUndefined()
    expect(persistableAgentModel('qwen3:8b', deps)).toBeUndefined()
    expect(persistableAgentModel(undefined, deps)).toBeUndefined()
  })
})

describe('resumeAgentModel', () => {
  test('metadata first, then a routed in-memory task model, else undefined (old metadata)', () => {
    expect(resumeAgentModel('acctz:glm-flash', 'claude-sonnet-x', deps)).toBe('acctz:glm-flash')
    expect(resumeAgentModel(undefined, 'acctz:glm-flash', deps)).toBe('acctz:glm-flash')
    expect(resumeAgentModel(undefined, 'claude-sonnet-x', deps)).toBeUndefined()
    expect(resumeAgentModel(undefined, undefined, deps)).toBeUndefined()
  })
})

describe('resume keeps the account end to end (metadata -> getAgentModel)', () => {
  test('a persisted acctz model survives the metadata round trip and resolves to acctz on resume', async () => {
    const id = asAgentId('a0123456789abcdef')
    const launched = getAgentModel(undefined, 'claude-sonnet-x', 'acctz:glm-flash', 'default')
    expect(launched).toBe('acctz:glm-flash')
    await writeAgentMetadata(id, { agentType: 'general-purpose', model: persistableAgentModel(launched) })
    const meta = await readAgentMetadata(id)
    expect(meta?.model).toBe('acctz:glm-flash')
    // What resumeAgent does: the persisted model is the explicit model.
    const resumed = getAgentModel(undefined, 'claude-sonnet-x', resumeAgentModel(meta?.model, undefined), 'default')
    expect(resumed).toBe('acctz:glm-flash')
  })

  test('old metadata without model resumes exactly as before (inherit from the parent)', async () => {
    const id = asAgentId('a00000000000000aa')
    await writeAgentMetadata(id, { agentType: 'general-purpose' })
    const meta = await readAgentMetadata(id)
    expect(meta?.model).toBeUndefined()
    const before = getAgentModel(undefined, 'claude-sonnet-x', undefined, 'default')
    expect(getAgentModel(undefined, 'claude-sonnet-x', resumeAgentModel(meta?.model, undefined), 'default')).toBe(before)
  })
})
