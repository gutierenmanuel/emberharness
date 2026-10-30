import { describe, expect, test } from 'bun:test'
import {
  agentModelParamError,
  buildModelPickerOptions,
  decodePickerValue,
  formatAgentAccountsSection,
  type AccountModelGroup,
  mergeClaudeEntries,
  claudeModelLabel,
} from './routedModels.js'

const groups: AccountModelGroup[] = [
  {
    accountId: 'qwen36',
    label: 'Qwen3.6 35B heretic (local)',
    active: true,
    models: [{ value: 'qwen36-35b-heretic-q4km', label: 'qwen36-35b-heretic-q4km', description: 'Modelo actual' }],
  },
  {
    accountId: 'claude',
    label: 'Claude (Anthropic)',
    active: false,
    models: [
      { value: 'default', label: 'Default', description: 'recomendado' },
      { value: 'sonnet', label: 'Sonnet', description: 'diario' },
      { value: 'haiku', label: 'Haiku', description: 'rápido' },
    ],
  },
  {
    accountId: 'openrouter',
    label: 'OpenRouter',
    active: false,
    models: [
      { value: 'deepseek/deepseek-chat', label: 'DeepSeek V3', description: '64k ctx' },
      { value: 'openai/gpt-4.1', label: 'GPT-4.1', description: '1M ctx' },
    ],
  },
]

describe('buildModelPickerOptions', () => {
  test('one header per account, models below, current marked', () => {
    const o = buildModelPickerOptions(groups, '', { account: 'qwen36', model: 'qwen36-35b-heretic-q4km' })
    expect(o.map(x => x.label)).toEqual([
      '── Qwen3.6 35B heretic (local) (qwen36) · cuenta activa ──',
      '● qwen36-35b-heretic-q4km',
      '── Claude (Anthropic) (claude) ──',
      '  Default',
      '  Sonnet',
      '  Haiku',
      '── OpenRouter (openrouter) ──',
      '  DeepSeek V3',
      '  GPT-4.1',
    ])
    expect(o.filter(x => x.disabled).map(x => x.value)).toEqual(['h:qwen36', 'h:claude', 'h:openrouter'])
    expect(o[1]!.value).toBe('qwen36:qwen36-35b-heretic-q4km')
  })

  test('stats go on the same line, names padded per account; no description', () => {
    const g: AccountModelGroup[] = [{
      accountId: 'venice', label: 'Venice', active: false,
      models: [
        { value: 'a', label: 'A', description: 'larga prosa', info: '1M ctx · $2/$10 por M' },
        { value: 'bbb', label: 'BBB', description: 'otra', info: '128k ctx' },
        { value: 'c', label: 'C', description: 'sin stats' },
      ],
    }]
    const o = buildModelPickerOptions(g, '', { account: 'claude', model: null })
    expect(o.slice(1).map(x => [x.label, x.info])).toEqual([
      ['  A  ', '1M ctx · $2/$10 por M'],
      ['  BBB', '128k ctx'],
      ['  C', undefined],
    ])
    expect(o.some(x => 'description' in x)).toBe(false)
    expect(buildModelPickerOptions(g, 'prosa', { account: 'claude', model: null }).map(x => x.value)).toEqual(['h:venice', 'venice:a'])
  })

  test('mergeClaudeEntries keeps the generic stats on a stock entry', () => {
    const out = mergeClaudeEntries([{ value: 'opus', label: 'Opus', description: 'x', info: '1M ctx' }], [{ value: 'opus', label: 'Opus 5.5', description: 'plan' }])
    expect(out[0]).toEqual({ value: 'opus', label: 'Opus 5.5', description: 'plan', info: '1M ctx' })
  })

  test('typing filters by model and by account; empty result says so', () => {
    const byModel = buildModelPickerOptions(groups, 'deep', { account: 'claude', model: null })
    expect(byModel.map(x => x.value)).toEqual(['h:openrouter', 'openrouter:deepseek/deepseek-chat'])
    const byAccount = buildModelPickerOptions(groups, 'claude', { account: 'claude', model: null })
    expect(byAccount.map(x => x.label)).toEqual(['── Claude (Anthropic) (claude) ──', '● Default', '  Sonnet', '  Haiku'])
    const twoWords = buildModelPickerOptions(groups, 'openrouter gpt', { account: 'claude', model: null })
    expect(twoWords.map(x => x.value)).toEqual(['h:openrouter', 'openrouter:openai/gpt-4.1'])
    expect(buildModelPickerOptions(groups, 'zzz', { account: 'claude', model: null })).toEqual([
      { value: 'h:none', label: '  (nada coincide con "zzz")', disabled: true },
    ])
  })
})

test('decodePickerValue splits at the first colon only', () => {
  expect(decodePickerValue('ollama:qwen3:8b')).toEqual({ account: 'ollama', model: 'qwen3:8b' })
  expect(decodePickerValue('h:claude')).toBeNull()
})

describe('formatAgentAccountsSection', () => {
  test('says model is required and lists every account with at most N models', () => {
    const text = formatAgentAccountsSection(groups, 1, 'qwen36:qwen36-35b-heretic-q4km')
    expect(text).toContain('`model` is REQUIRED on every Agent call and must be `cuenta:modelo`')
    expect(text).toContain("pass `qwen36:qwen36-35b-heretic-q4km`")
    expect(text).toContain('- qwen36 (cuenta de la sesión): qwen36-35b-heretic-q4km')
    expect(text).toContain('- claude: sonnet (+1 más)')
    expect(text).toContain('- openrouter: deepseek/deepseek-chat (+1 más)')
  })
  test('still explains the format with only the session account', () => {
    expect(formatAgentAccountsSection([groups[0]!])).toContain('REQUIRED')
  })
})

describe('agentModelParamError', () => {
  const route = (m: string) => {
    if (m.startsWith('openai:')) throw new Error('needs an API key')
    return m.startsWith('qwen36:') || m.startsWith('claude:') ? {} : null
  }
  test('only a routable cuenta:modelo with both parts passes', () => {
    expect(agentModelParamError('qwen36:x', route)).toBeNull()
    expect(agentModelParamError('claude:haiku', route)).toBeNull()
  })
  test('missing model, bare alias or bare id are rejected with the format', () => {
    expect(agentModelParamError(undefined, route, 'claude:opus')).toMatch(/missing.*cuenta:modelo.*this session: claude:opus/)
    expect(agentModelParamError('', route)).toMatch(/missing/)
    expect(agentModelParamError('haiku', route)).toMatch(/no account.*cuenta:modelo/)
    expect(agentModelParamError('gpt-4.1', route)).toMatch(/no account/)
  })
  test('empty model after the account, unknown account and unusable account', () => {
    expect(agentModelParamError('qwen36:', route)).toMatch(/names no model/)
    expect(agentModelParamError('qwen3:8b', route)).toMatch(/"qwen3" is not a connected account/)
    expect(agentModelParamError('openai:gpt-4.1', route)).toMatch(/needs an API key/)
  })
})

describe('mergeClaudeEntries', () => {
  const e = (value: string, description = '') => ({ value, label: value, description })
  test('keeps the full list and appends plan-only stock entries', () => {
    const out = mergeClaudeEntries([e('default'), e('opus'), e('claude-opus-4-8')], [e('default'), e('opus', 'plan'), e('opus[1m]')])
    expect(out.map(m => m.value)).toEqual(['default', 'opus', 'claude-opus-4-8', 'opus[1m]'])
    expect(out[1]!.description).toBe('plan')
  })
  test('without stock entries returns the full list', () => {
    const full = [e('default'), e('claude-haiku-4-5')]
    expect(mergeClaudeEntries(full, undefined)).toBe(full)
  })
})

describe('claudeModelLabel', () => {
  test('plain, named and missing versions', () => {
    expect(claudeModelLabel('opus', '5.5', 'claude-opus-5-5')).toBe('Opus 5.5')
    expect(claudeModelLabel('opus', '5.1 Fable', 'claude-fable-5-1')).toBe('Fable 5.1')
    expect(claudeModelLabel('opus', undefined, 'claude-opus-4-1')).toBe('claude-opus-4-1')
  })
})
