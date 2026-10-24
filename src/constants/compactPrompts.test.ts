import { describe, expect, test } from 'bun:test'
import {
  buildCompactSystemPrompt,
  compactAgentDescription,
  compactToolDescription,
  isCompactToolSet,
} from './compactPrompts.js'

const names = (...n: string[]) => n.map(name => ({ name }))
const SIX = names('Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep')

describe('isCompactToolSet', () => {
  test('the Simple pool, with or without Agent', () => {
    expect(isCompactToolSet([...SIX, ...names('Agent')])).toBe(true)
    expect(isCompactToolSet(SIX)).toBe(true)
  })
  test('anything else keeps the regular prompts', () => {
    expect(isCompactToolSet([])).toBe(false)
    expect(isCompactToolSet(names('Read', 'Grep'))).toBe(false)
    expect(isCompactToolSet([...SIX, ...names('Agent', 'Skill')])).toBe(false)
    expect(isCompactToolSet([...SIX, ...names('mcp__x__y')])).toBe(false)
  })
})

describe('buildCompactSystemPrompt', () => {
  const env = { cwd: '/w', isGit: true, platform: 'linux', shell: 'zsh', osVersion: 'Linux 7', date: '2026-10-24' }
  test('has identity and environment and stays small', () => {
    const p = buildCompactSystemPrompt(env)
    expect(p).toContain('fnharness')
    expect(p).toContain('Working directory: /w')
    expect(p).toContain('Git repository: yes')
    expect(p).toContain('2026-10-24')
    expect(p.length / 4).toBeLessThan(600)
  })
  test('optional directories and language', () => {
    const p = buildCompactSystemPrompt({ ...env, isGit: false, additionalDirs: ['/a', '/b'], language: 'Spanish' })
    expect(p).toContain('Git repository: no')
    expect(p).toContain('/a, /b')
    expect(p).toContain('Always answer in Spanish')
  })
})

describe('compact tool descriptions', () => {
  test('every Simple tool has one, short', () => {
    for (const n of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent']) {
      const d = compactToolDescription(n, [], true)
      expect(d).toBeDefined()
      expect(d!.length).toBeLessThan(900)
    }
    expect(compactToolDescription('WebFetch', [], true)).toBeUndefined()
  })
  test('Agent lists the agent types only when asked, one truncated line each', () => {
    const agents = [{ agentType: 'scout', whenToUse: 'x'.repeat(300) }]
    const withList = compactAgentDescription(agents, true)
    expect(withList).toContain('- scout: ')
    expect(withList.length).toBeLessThan(compactAgentDescription([], true).length + 120)
    expect(compactAgentDescription(agents, false)).not.toContain('scout')
  })
})
