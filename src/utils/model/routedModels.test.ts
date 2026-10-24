import { describe, expect, test } from 'bun:test'
import {
  agentModelParamError,
  buildModelPickerOptions,
  decodePickerValue,
  formatAgentAccountsSection,
  type AccountModelGroup,
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
  test('lists every account with at most N models', () => {
    const text = formatAgentAccountsSection(groups, 1)
    expect(text).toContain('`model` also accepts `cuenta:modelo`')
    expect(text).toContain('- qwen36 (cuenta de la sesión): qwen36-35b-heretic-q4km')
    expect(text).toContain('- claude: sonnet (+1 más)')
    expect(text).toContain('- openrouter: deepseek/deepseek-chat (+1 más)')
  })
  test('nothing to say with only the session account', () => {
    expect(formatAgentAccountsSection([groups[0]!])).toBe('')
  })
})

describe('agentModelParamError', () => {
  const route = (m: string) => {
    if (m.startsWith('openai:')) throw new Error('needs an API key')
    return m.includes(':') ? {} : null
  }
  test('aliases and routable cuenta:modelo pass; the rest explain why', () => {
    expect(agentModelParamError(undefined, route)).toBeNull()
    expect(agentModelParamError('haiku', route)).toBeNull()
    expect(agentModelParamError('qwen36:x', route)).toBeNull()
    expect(agentModelParamError('openai:gpt-4.1', route)).toMatch(/needs an API key/)
    expect(agentModelParamError('gpt-4.1', route)).toMatch(/cuenta:modelo/)
  })
})
