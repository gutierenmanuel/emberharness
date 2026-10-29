import { describe, expect, test } from 'bun:test'
import {
  describeLatestClaudeModels,
  getLatestClaudeModels,
  getModelIdentity,
} from './modelIdentity.js'

describe('getModelIdentity', () => {
  test('claude-sonnet-5-5 se reconoce aunque no tenga corte de conocimiento', () => {
    const id = getModelIdentity('claude-sonnet-5-5')
    expect(id.family).toBe('claude')
    expect(id.marketingName).toBe('Sonnet 5.5')
    expect(id.knowledgeCutoff).toBeUndefined()
    expect(id.supportsFastMode).toBe(false)
    expect(id.coAuthorName).toBe('Claude Sonnet 5.5')
    expect(id.coAuthorEmail).toBe('noreply@anthropic.com')
  })

  test('opus 4.6 conserva corte y modo rápido, con fecha o [1m]', () => {
    for (const raw of ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-opus-4-6-20260101']) {
      const id = getModelIdentity(raw)
      expect(id.marketingName).toBe('Opus 4.6')
      expect(id.knowledgeCutoff).toBe('May 2025')
      expect(id.supportsFastMode).toBe(true)
    }
  })

  test('el sufijo de fecha no se confunde con la versión menor', () => {
    expect(getModelIdentity('claude-sonnet-4-20250514').marketingName).toBe('Sonnet 4')
    expect(getModelIdentity('claude-haiku-4-5-20251001').marketingName).toBe('Haiku 4.5')
  })

  test('Claude con formato desconocido no inventa versión', () => {
    const id = getModelIdentity('claude-mythos-preview')
    expect(id.family).toBe('claude')
    expect(id.marketingName).toBeUndefined()
    expect(id.coAuthorName).toBe('Claude (claude-mythos-preview)')
  })

  test('modelos no Claude no heredan nada de Claude', () => {
    const q = getModelIdentity('qwen36-35b-heretic-q4km')
    expect(q.family).toBe('other')
    expect(q.marketingName).toBeUndefined()
    expect(q.supportsFastMode).toBe(false)
    expect(q.coAuthorName).toBe('qwen36-35b-heretic-q4km')
    expect(q.coAuthorEmail).not.toContain('anthropic')
    expect(getModelIdentity('gpt-5.4').family).toBe('openai')
  })
})

describe('ventana de contexto nativa', () => {
  test('Sonnet 5.5 y Opus 5.5 traen 1M; el resto no declara ventana propia', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]']) {
      expect(getModelIdentity(m).contextWindow).toBe(1_000_000)
    }
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'qwen36-35b-heretic-q4km']) {
      expect(getModelIdentity(m).contextWindow).toBeUndefined()
    }
  })
})

describe('modelos Claude más recientes', () => {
  test('cada tier usa su versión más alta conocida', () => {
    const latest = getLatestClaudeModels()
    expect(latest.sonnet.marketingName).toBe('Sonnet 5.5')
    expect(latest.opus.marketingName).toBe('Opus 5.5')
    expect(latest.haiku.apiId).toBe('claude-haiku-5-5')
    const text = describeLatestClaudeModels()
    expect(text).toContain("Sonnet 5.5: 'claude-sonnet-5-5'")
    expect(text).not.toContain('4.5/4.6')
  })
})
