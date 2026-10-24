import { describe, expect, test } from 'bun:test'
import {
  accountTag,
  canonicalRoutedModel,
  resolveClaudeAlias,
  routeForModel,
  splitAccountModel,
  withModelRoute,
  withModelRouteGenerator,
} from './accountRouting.js'
import { accountPredicate } from './fallbackChain.js'
import {
  getMultimodelProfile,
  getScopedAccountId,
  isMultimodelActive,
  resolveProfile,
  type MultimodelProfile,
} from './openai-compat/profiles.js'

const DEFAULTS = { opus: 'claude-opus-x', sonnet: 'claude-sonnet-x', haiku: 'claude-haiku-x' }
const store = {
  accounts: {
    acctb: { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'model-b' },
    openrouter: { apiKey: 'k' },
  },
}
const isAccount = accountPredicate(store)

describe('splitAccountModel', () => {
  test('a known prefix is an account, anything else stays a model id', () => {
    expect(splitAccountModel('qwen36:qwen36-35b-heretic-q4km', isAccount)).toEqual({ account: 'qwen36', model: 'qwen36-35b-heretic-q4km' })
    expect(splitAccountModel('claude:haiku', isAccount)).toEqual({ account: 'claude', model: 'haiku' })
    expect(splitAccountModel('openrouter:deepseek/deepseek-chat', isAccount)).toEqual({ account: 'openrouter', model: 'deepseek/deepseek-chat' })
    expect(splitAccountModel('ollama:qwen3:8b', isAccount)).toEqual({ account: 'ollama', model: 'qwen3:8b' })
    expect(splitAccountModel('acctb:', isAccount)).toEqual({ account: 'acctb', model: '' })
    expect(splitAccountModel('qwen3:8b', isAccount)).toBeNull()
    expect(splitAccountModel('claude-haiku-4-5', isAccount)).toBeNull()
    expect(splitAccountModel('qwen36', isAccount)).toBeNull()
  })
})

describe('resolveClaudeAlias', () => {
  test('aliases read the original slots, then the defaults; ids pass through', () => {
    expect(resolveClaudeAlias('haiku', {}, DEFAULTS)).toBe('claude-haiku-x')
    expect(resolveClaudeAlias('Sonnet[1m]', {}, DEFAULTS)).toBe('claude-sonnet-x[1m]')
    expect(resolveClaudeAlias('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'pinned-opus' }, DEFAULTS)).toBe('pinned-opus')
    expect(resolveClaudeAlias('', {}, DEFAULTS)).toBe('claude-sonnet-x')
    expect(resolveClaudeAlias('default', { ANTHROPIC_MODEL: 'haiku' }, DEFAULTS)).toBe('claude-haiku-x')
    expect(resolveClaudeAlias('claude-haiku-4-5-20251001', {}, DEFAULTS)).toBe('claude-haiku-4-5-20251001')
  })
})

describe('routeForModel', () => {
  const deps = { env: {}, store, claudeDefaults: DEFAULTS, originalSlots: {} }

  test('no prefix means no route', () => {
    expect(routeForModel('qwen3:8b', { ...deps, currentAccount: 'claude' })).toBeNull()
    expect(routeForModel('sonnet', { ...deps, currentAccount: 'claude' })).toBeNull()
    expect(routeForModel(undefined, deps)).toBeNull()
  })

  test('claude: goes native with the alias resolved, from any session', () => {
    const r = routeForModel('claude:haiku', { ...deps, currentAccount: 'qwen36' })!
    expect(r).toEqual({ accountId: 'claude', profile: null, model: 'claude-haiku-x', current: false })
    expect(routeForModel('claude:haiku', { ...deps, currentAccount: 'claude' })!.current).toBe(true)
  })

  test('an OpenAI-compatible account gets its profile with the model pinned', () => {
    const r = routeForModel('acctb:other', { ...deps, currentAccount: 'claude' })!
    expect(r.accountId).toBe('acctb')
    expect(r.current).toBe(false)
    expect(r.model).toBe('other')
    expect(r.profile?.baseUrl).toBe('http://127.0.0.1:9/v1')
    expect(r.profile?.model).toBe('other')
    expect(routeForModel('acctb:', { ...deps, currentAccount: 'claude' })!.model).toBe('model-b')
  })

  test('the account in force keeps its own profile (launch flags included)', () => {
    const live = { ...resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'custom', CLAUDE_MULTIMODEL_BASE_URL: 'http://x/v1' })! }
    const r = routeForModel('acctb:m2', { ...deps, currentAccount: 'acctb', currentProfile: live })!
    expect(r.current).toBe(true)
    expect(r.profile?.baseUrl).toBe('http://x/v1')
    expect(r.profile?.model).toBe('m2')
  })

  test('an account that cannot serve throws a clear error', () => {
    expect(() => routeForModel('openai:gpt-4.1', { ...deps, currentAccount: 'claude' })).toThrow(/API key/)
  })

  test('canonical form keeps the prefix with the model resolved', () => {
    expect(canonicalRoutedModel('claude:haiku', { ...deps, currentAccount: 'qwen36' })).toBe('claude:claude-haiku-x')
    expect(canonicalRoutedModel('acctb:', { ...deps, currentAccount: 'claude' })).toBe('acctb:model-b')
    expect(canonicalRoutedModel('haiku', deps)).toBeUndefined()
  })

  test('accountTag only names accounts other than the session', () => {
    expect(accountTag({ accountId: 'qwen36' }, 'claude')).toBe('qwen36')
    expect(accountTag({ accountId: 'claude' }, 'claude')).toBeUndefined()
    expect(accountTag(null, 'claude')).toBeUndefined()
  })
})

describe('request scope', () => {
  const qwen: MultimodelProfile = resolveProfile({ CLAUDE_MULTIMODEL_PROVIDER: 'qwen36' })!

  test('inside a routed call the profile is the routed one, outside the session one', async () => {
    const before = getMultimodelProfile()
    const route = { accountId: 'qwen36', profile: qwen, model: 'm', current: false }
    const seen = await withModelRoute(
      'qwen36:m',
      async model => {
        await Bun.sleep(1)
        return { model, profile: getMultimodelProfile()?.provider, account: getScopedAccountId(), mm: isMultimodelActive() }
      },
      route,
    )
    expect(seen).toEqual({ model: 'm', profile: 'qwen36', account: 'qwen36', mm: true })
    expect(getMultimodelProfile()).toBe(before)
    expect(getScopedAccountId()).toBeUndefined()
  })

  test('claude scope turns multimodel off for the call only', () => {
    const route = { accountId: 'claude', profile: null, model: 'claude-haiku-x', current: false }
    expect(withModelRoute('claude:haiku', () => isMultimodelActive(), route)).toBe(false)
  })

  test('a generator keeps the scope across yields and awaits, the caller keeps its own', async () => {
    const route = { accountId: 'qwen36', profile: qwen, model: 'm', current: false }
    async function* body(model: string) {
      yield `${model}:${getScopedAccountId()}`
      await Bun.sleep(2)
      yield `${model}:${getScopedAccountId()}`
    }
    const out: string[] = []
    for await (const v of withModelRouteGenerator(route, body)) out.push(v, String(getScopedAccountId()))
    expect(out).toEqual(['m:qwen36', 'undefined', 'm:qwen36', 'undefined'])
  })

  test('timers created inside a finished scope fall back to the session account', async () => {
    const route = { accountId: 'qwen36', profile: qwen, model: 'm', current: false }
    let later: Promise<string | undefined> | undefined
    withModelRoute('qwen36:m', () => {
      later = new Promise(resolve => setTimeout(() => resolve(getScopedAccountId()), 5))
    }, route)
    expect(await later).toBeUndefined()
  })
})
