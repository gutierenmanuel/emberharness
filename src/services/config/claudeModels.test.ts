import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  claudeAliasApiId,
  claudeAliasName,
  claudePrices,
  getClaudeModels,
  mergeClaudeModels,
  parsePrices,
  resetClaudeModelsForTesting,
} from './claudeModels.js'

const savedDir = process.env.CLAUDE_CONFIG_DIR
beforeEach(() => resetClaudeModelsForTesting())
afterEach(() => {
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedDir
  resetClaudeModelsForTesting()
})

describe('defaults', () => {
  test('los alias apuntan a los modelos 5.5', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-cm-'))
    expect(claudeAliasApiId('sonnet')).toBe('claude-sonnet-5-5')
    expect(claudeAliasApiId('opus')).toBe('claude-opus-5-5')
    expect(claudeAliasApiId('haiku')).toBe('claude-haiku-5-5')
    expect(claudeAliasName('opus')).toBe('Opus 5.5')
  })

  test('tarifas por modelo y modo rápido de Opus 4.6', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-cm-'))
    expect(claudePrices('claude-sonnet-4-6')?.inputTokens).toBe(3)
    expect(claudePrices('claude-opus-4-6')?.outputTokens).toBe(25)
    expect(claudePrices('claude-opus-4-6', true)?.outputTokens).toBe(150)
    expect(claudePrices('claude-sonnet-4-6', true)?.outputTokens).toBe(15) // sin tarifa rápida: la normal
    expect(claudePrices('modelo-inexistente')).toBeUndefined()
  })
})

describe('mergeClaudeModels', () => {
  const base = () => getClaudeModels()

  test('cambia un alias y añade un modelo con tarifa sin tocar el resto', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-cm-'))
    const merged = mergeClaudeModels(base(), {
      aliases: { sonnet: 'claude-sonnet-6-0' },
      models: {
        'claude-sonnet-6-0': { tier: 'sonnet', version: '6.0', apiId: 'claude-sonnet-6-0', pricing: { input: 4, output: 20 } },
      },
    })
    expect(merged.aliases.sonnet).toBe('claude-sonnet-6-0')
    expect(merged.aliases.opus).toBe('claude-opus-5-5')
    const p = merged.models['claude-sonnet-6-0']!.pricing!
    expect([p.inputTokens, p.outputTokens, p.promptCacheWriteTokens, p.promptCacheReadTokens]).toEqual([4, 20, 5, 0.4])
  })

  test('una tarifa parcial se superpone a la existente', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-cm-'))
    const merged = mergeClaudeModels(base(), { models: { 'claude-opus-5-5': { pricing: { output: 30 } } } })
    const p = merged.models['claude-opus-5-5']!.pricing!
    expect([p.inputTokens, p.outputTokens]).toEqual([4, 30])
    expect(merged.models['claude-opus-5-5']!.contextWindow).toBe(1_000_000)
  })

  test('entradas inválidas se ignoran; un JSON que no es objeto lanza', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fnh-cm-'))
    const merged = mergeClaudeModels(base(), { aliases: { opus: 5 }, models: { x: 'texto' }, picker: [{ alias: 'nada' }] })
    expect(merged.aliases.opus).toBe('claude-opus-5-5')
    expect(merged.models.x).toBeUndefined()
    expect(merged.picker).toEqual([])
    expect(() => mergeClaudeModels(base(), [])).toThrow()
  })

  test('parsePrices exige input y output', () => {
    expect(parsePrices({ input: 1 })).toBeUndefined()
    expect(parsePrices({ input: 2, output: 8 })?.promptCacheWriteTokens).toBe(2.5)
  })
})

describe('hot reload desde el fichero de usuario', () => {
  test('claude-models.json cambia el alias en caliente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnh-cm-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    expect(claudeAliasApiId('sonnet')).toBe('claude-sonnet-5-5')
    writeFileSync(join(dir, 'claude-models.json'), JSON.stringify({ aliases: { sonnet: 'claude-sonnet-4-6' } }))
    resetClaudeModelsForTesting() // equivale a que haya pasado el intervalo de comprobación
    expect(claudeAliasApiId('sonnet')).toBe('claude-sonnet-4-6')
  })
})
