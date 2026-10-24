import { describe, expect, test } from 'bun:test'
import { diffSkillNames, formatReloadSkillsMessage } from './diffSkills.js'

describe('diffSkillNames', () => {
  test('detects added and removed, sorted', () => {
    expect(diffSkillNames(['a', 'b'], ['b', 'd', 'c'])).toEqual({
      added: ['c', 'd'],
      removed: ['a'],
      total: 3,
    })
  })
  test('no changes', () => {
    expect(diffSkillNames(['a'], ['a'])).toEqual({ added: [], removed: [], total: 1 })
  })
})

describe('formatReloadSkillsMessage', () => {
  test('lists changes', () => {
    expect(formatReloadSkillsMessage({ added: ['x'], removed: ['y'], total: 4 })).toBe(
      'Reloaded 4 skills · new: x · gone: y',
    )
  })
  test('reports no changes and singular', () => {
    expect(formatReloadSkillsMessage({ added: [], removed: [], total: 1 })).toBe(
      'Reloaded 1 skill · no changes',
    )
  })
})
