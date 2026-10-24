import { describe, expect, test } from 'bun:test'
import { formatRecap } from './formatRecap.js'

describe('formatRecap', () => {
  test('returns null for empty input', () => {
    expect(formatRecap(null)).toBeNull()
    expect(formatRecap(undefined)).toBeNull()
    expect(formatRecap('  \n ')).toBeNull()
  })
  test('joins lines into one', () => {
    expect(formatRecap('Arreglas el build.\nSiguiente: probar.\n')).toBe(
      'Arreglas el build. Siguiente: probar.',
    )
  })
  test('drops list markers and repeated spaces', () => {
    expect(formatRecap('- uno\n- dos   tres\n1. cuatro')).toBe('uno dos tres cuatro')
  })
})
