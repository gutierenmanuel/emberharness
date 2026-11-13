import { describe, expect, test } from 'bun:test'
import { combinePerfilEstimate } from './perfilEstimate.js'

const base = { system: 1000, tools: 400, skills: 100, toolCount: 6 }
const ctx = { bare: false, claudeMd: true, memory: true, hooks: true, mcp: true, skills: true }

describe('combinePerfilEstimate', () => {
  test('default suma sistema, herramientas, skills y CLAUDE.md', () => {
    const e = combinePerfilEstimate(base, { systemPrompt: { mode: 'default' }, context: ctx }, 300)
    expect(e).toMatchObject({ system: 1000, claudeMd: 300, total: 1800, toolCount: 6 })
  })
  test('replace sustituye el sistema por el texto del perfil', () => {
    const e = combinePerfilEstimate(base, { systemPrompt: { mode: 'replace', text: 'x'.repeat(40) }, context: ctx }, 0)
    expect(e.system).toBe(10)
    expect(e.total).toBe(10 + 400 + 100)
  })
  test('append suma el texto; bare y claudeMd:false no cuentan el CLAUDE.md', () => {
    const e = combinePerfilEstimate(base, { systemPrompt: { mode: 'append', text: 'x'.repeat(40) }, context: { ...ctx, claudeMd: false } }, 300)
    expect(e.system).toBe(1010)
    expect(e.claudeMd).toBe(0)
    expect(combinePerfilEstimate(base, { systemPrompt: { mode: 'default' }, context: { ...ctx, bare: true } }, 300).claudeMd).toBe(0)
  })
})
