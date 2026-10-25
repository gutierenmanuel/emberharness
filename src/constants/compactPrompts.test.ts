import { describe, expect, test } from 'bun:test'
import {
  buildCompactSystemPrompt,
  compactAgentDescription,
  compactToolDescription,
  isCompactToolSet,
  shortenDescription,
  slimSchemaDescriptions,
  trimClaudeMdForCompact,
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

describe('trimClaudeMdForCompact', () => {
  const head = 'Codebase and user instructions are shown below.\n\n'
  const seg = (p: string, n: number) => `Contents of ${p} (project instructions):\n\n${'x'.repeat(n)}\n\n`
  test('keeps short files and drops long ones, listing them', () => {
    const out = trimClaudeMdForCompact(head + seg('/a/short.md', 100) + seg('/a/big.md', 5000), 1000)
    expect(out).toContain('/a/short.md')
    expect(out).not.toContain('x'.repeat(2000))
    expect(out).toContain('omitted to save context')
    expect(out).toContain('/a/big.md')
  })
  test('drops files that overflow the total budget, keeping the first ones', () => {
    const out = trimClaudeMdForCompact(head + seg('/a/1.md', 900) + seg('/a/2.md', 900) + seg('/a/3.md', 900), 1000, 2200)
    expect(out).toContain('Contents of /a/1.md')
    expect(out).toContain('Contents of /a/2.md')
    expect(out).not.toContain('Contents of /a/3.md')
    expect(out).toContain('/a/3.md')
  })
  test('returns the input untouched when nothing is long, or when disabled', () => {
    const md = head + seg('/a/short.md', 100)
    expect(trimClaudeMdForCompact(md, 1000)).toBe(md)
    expect(trimClaudeMdForCompact(head + seg('/a/big.md', 5000), 0)).toContain('x'.repeat(5000))
  })
})

describe('slimSchemaDescriptions', () => {
  test('cuts descriptions to the first sentence, keeps everything else', () => {
    const schema = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string', description: 'First sentence. Second sentence that is dropped.' },
        description: { type: 'string', description: 'x'.repeat(300) },
        e: { type: 'string', enum: ['u', 'v'], description: 'Mode: one of u or v' },
      },
    }
    const out = slimSchemaDescriptions(schema, 40) as typeof schema
    expect(out.properties.a.description).toBe('First sentence.')
    expect(out.properties.description.description!.length).toBeLessThanOrEqual(40)
    expect(out.properties.e.enum).toEqual(['u', 'v'])
    expect(out.required).toEqual(['a'])
    expect(Object.keys(out.properties)).toEqual(['a', 'description', 'e'])
  })
  test('a property literally named description is not mistaken for text', () => {
    const out = slimSchemaDescriptions({ properties: { description: { type: 'string' } } }) as any
    expect(out.properties.description).toEqual({ type: 'string' })
  })
  test('disabled with 0; shortenDescription breaks on a word', () => {
    const s = { properties: { a: { description: 'a long text that goes on. And more.' } } }
    expect(slimSchemaDescriptions(s, 0)).toBe(s)
    expect(shortenDescription('alpha beta gamma delta', 12)).toBe('alpha beta')
    expect(shortenDescription('Glob to filter (e.g. "*.js") - maps to rg. More.', 90)).toBe('Glob to filter (e.g. "*.js") - maps to rg.')
    expect(shortenDescription('Shows lines (supports -A/-B/-C context, -n line numbers and more', 40)).toBe('Shows lines')
  })
})
