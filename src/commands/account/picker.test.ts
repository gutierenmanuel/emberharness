import { describe, expect, test } from 'bun:test'
import type { Catalog } from '../../services/api/openai-compat/catalog.js'
import { buildPickerSections, presetKeyHint } from './actions.js'

const acc = (id: string, ready: boolean, label = id) => ({ id, label, provider: id, baseUrl: null, ready, detail: 'd' })
const prov = (id: string, n: number, kind: 'openai' | 'other' = 'openai') => ({
  id,
  name: id.toUpperCase(),
  env: [`${id.toUpperCase()}_KEY`],
  npm: '',
  kind,
  baseUrl: kind === 'openai' ? 'https://x/v1' : null,
  models: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `m${i}`, reasoning: false, image: false })),
})
const catalog = {
  aaa: prov('aaa', 2),
  bbb: prov('bbb', 9),
  ccc: prov('ccc', 2),
  groq: prov('groq', 5),
  nope: prov('nope', 3, 'other'),
  saved: prov('saved', 4),
} as Catalog

describe('buildPickerSections', () => {
  const accounts = [acc('claude', true), acc('ollama', true), acc('groq', false), acc('mine', false)]

  test('ready and saved accounts are active; keyless presets go to add', () => {
    const { active, add } = buildPickerSections(accounts, catalog, '', { mine: {} })
    expect(active.map(e => e.id)).toEqual(['claude', 'ollama', 'mine'])
    expect(add[0]).toMatchObject({ kind: 'preset', id: 'groq' })
  })

  test('catalog providers come after presets, by model count then name, skipping saved/unusable', () => {
    const { add } = buildPickerSections(accounts, catalog, '', { saved: {} })
    expect(add.map(e => e.id)).toEqual(['groq', 'bbb', 'aaa', 'ccc'])
    expect(add[1]).toMatchObject({ kind: 'catalog', modelCount: 9 })
  })

  test('query filters only the add section', () => {
    const { active, add } = buildPickerSections(accounts, catalog, 'BB')
    expect(active).toHaveLength(3)
    expect(add.map(e => e.id)).toEqual(['bbb'])
  })

  test('presetKeyHint names command and env var', () => {
    expect(presetKeyHint('openai')).toContain('/account key openai <apikey>')
    expect(presetKeyHint('openai')).toContain('OPENAI_API_KEY')
  })
})
