import { describe, expect, test } from 'bun:test'
import { displayModelId } from './multimodelOptions.js'

describe('displayModelId', () => {
  test('keeps plain ids', () => {
    expect(displayModelId('qwen3:8b')).toBe('qwen3:8b')
  })
  test('turns a gguf path into its basename', () => {
    expect(displayModelId('/home/u/models/qwen36-35b-heretic-q4km.gguf')).toBe('qwen36-35b-heretic-q4km')
  })
  test('keeps provider/model ids readable', () => {
    expect(displayModelId('meta-llama/Llama-3.3-70B')).toBe('Llama-3.3-70B')
  })
})
