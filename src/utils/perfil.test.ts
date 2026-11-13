import { describe, expect, test } from 'bun:test'
import { filterToolsByProfile, formatProfile } from './contextProfile.js'
import {
  effectiveSystemPrompts,
  mergePerfiles,
  parsePerfil,
  parsePerfilArgs,
  perfilFromScope,
  perfilToJson,
  requiresRestart,
  restartReasons,
  toScope,
  toStartupPatch,
  type Perfil,
} from './perfil.js'

function ok(raw: unknown, name = 'x'): Perfil {
  const r = parsePerfil(raw, name)
  if (!r.ok) throw new Error(r.error)
  return r.perfil
}

describe('parsePerfil', () => {
  test('un objeto vacío da el comportamiento actual (todo por defecto)', () => {
    const p = ok({})
    expect(p.tools).toBe('default')
    expect(p.systemPrompt).toEqual({ mode: 'default' })
    expect(p.context).toEqual({ bare: false, claudeMd: true, memory: true, hooks: true, mcp: true, skills: true })
  })
  test('bare fuerza claudeMd, memory y hooks a false', () => {
    const p = ok({ context: { bare: true, claudeMd: true, memory: true, hooks: true } })
    expect(p.context).toMatchObject({ bare: true, claudeMd: false, memory: false, hooks: false })
  })
  test('replace sin text ni file es un error; append también', () => {
    expect(parsePerfil({ systemPrompt: { mode: 'replace' } }, 'x').ok).toBe(false)
    expect(parsePerfil({ systemPrompt: { mode: 'append' } }, 'x').ok).toBe(false)
    expect(parsePerfil({ systemPrompt: { mode: 'replace', file: 'p.md' } }, 'x').ok).toBe(true)
    expect(parsePerfil({ systemPrompt: { mode: 'default' } }, 'x').ok).toBe(true)
  })
  test('modo, tools y context mal formados se rechazan', () => {
    expect(parsePerfil({ systemPrompt: { mode: 'otro', text: 'a' } }, 'x').ok).toBe(false)
    expect(parsePerfil({ tools: 'todas' }, 'x').ok).toBe(false)
    expect(parsePerfil({ tools: [1] }, 'x').ok).toBe(false)
    expect(parsePerfil({ context: { hooks: 'si' } }, 'x').ok).toBe(false)
    expect(parsePerfil({ context: { mcp: 3 } }, 'x').ok).toBe(false)
    expect(parsePerfil([], 'x').ok).toBe(false)
    expect(parsePerfil({}, 'a/b').ok).toBe(false)
  })
  test('avisa de herramientas desconocidas sin rechazar el perfil', () => {
    const r = parsePerfil({ tools: ['Read', 'Escribir', 'mcp__a__b'] }, 'x')
    expect(r.ok && r.warnings).toEqual(['herramienta desconocida: "Escribir"'])
  })
})

describe('mergePerfiles', () => {
  test('el del usuario sustituye al de fábrica por nombre', () => {
    const f = { a: ok({ description: 'fábrica' }, 'a'), b: ok({}, 'b') }
    const u = { a: ok({ description: 'usuario' }, 'a'), c: ok({}, 'c') }
    const m = mergePerfiles(f, u)
    expect(Object.keys(m).sort()).toEqual(['a', 'b', 'c'])
    expect(m.a!.description).toBe('usuario')
  })
})

describe('toScope', () => {
  test('perfil por defecto = Full', () => {
    expect(toScope(ok({}))).toEqual({ mcp: 'full', skill: 'full', tools: 'full' })
  })
  test('lista de tools, mcp apagado y skills apagadas', () => {
    const s = toScope(ok({ tools: ['Read', 'Write'], context: { mcp: false, skills: false } }))
    expect(s).toEqual({ mcp: 'none', skill: 'none', tools: 'simple', toolNames: ['Read', 'Write'] })
    expect(formatProfile(s)).toBe('mcp:none skill:none tools:[Read,Write]')
  })
  test('lista de servidores mcp', () => {
    const s = toScope(ok({ context: { mcp: ['registry'] } }))
    expect(s).toMatchObject({ mcp: 'full', mcpServers: ['registry'] })
  })
  test('el scope con toolNames filtra solo esas herramientas, y las MCP según mcpServers', () => {
    const pool = ['Read', 'Write', 'Bash', 'Skill', 'Agent'].map(name => ({ name }))
    const mcp = [
      { name: 'mcp__registry__a', isMcp: true, mcpInfo: { serverName: 'registry', toolName: 'a' } },
      { name: 'mcp__otro__b', isMcp: true, mcpInfo: { serverName: 'otro', toolName: 'b' } },
    ]
    const p = toScope(ok({ tools: ['Read', 'Write', 'Skill'], context: { mcp: ['registry'] } }))
    const out = filterToolsByProfile([...pool, ...mcp], p, () => 'user').map(t => t.name)
    expect(out).toEqual(['Read', 'Write', 'Skill', 'mcp__registry__a'])
    const sinSkills = toScope(ok({ tools: ['Read', 'Skill'], context: { skills: false } }))
    expect(filterToolsByProfile(pool, sinSkills, () => 'user').map(t => t.name)).toEqual(['Read'])
  })
})

describe('toStartupPatch', () => {
  test('full no toca nada', () => {
    expect(toStartupPatch(ok({}))).toEqual({ env: {}, options: {} })
  })
  test('minimo: bare, prompt de reemplazo y apagados', () => {
    const p = ok({ systemPrompt: { mode: 'replace', text: 'hola' }, context: { bare: true, mcp: false, skills: false } })
    const patch = toStartupPatch(p)
    expect(patch.options).toEqual({ bare: true, systemPrompt: 'hola' })
    expect(patch.env).toMatchObject({
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      FNHARNESS_PERFIL_NO_HOOKS: '1',
    })
  })
  test('append va a appendSystemPrompt; memory false solo apaga la memoria', () => {
    const patch = toStartupPatch(ok({ systemPrompt: { mode: 'append', text: 'extra' }, context: { memory: false } }))
    expect(patch.options).toEqual({ appendSystemPrompt: 'extra' })
    expect(patch.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  })
})

describe('requiresRestart', () => {
  const full = ok({}, 'full')
  const bare = ok({ context: { bare: true } }, 'bare')
  const sinHooks = ok({ context: { hooks: false } }, 'sinhooks')
  test('lo que se cambia en caliente no reinicia', () => {
    expect(requiresRestart(full, ok({ tools: ['Read'], context: { memory: false, mcp: false } }))).toBe(false)
    expect(requiresRestart(full, sinHooks)).toBe(false)
    expect(requiresRestart(undefined, bare)).toBe(false)
  })
  test('bare en cualquier sentido y hooks off→on reinician', () => {
    expect(requiresRestart(full, bare)).toBe(true)
    expect(requiresRestart(bare, full)).toBe(true)
    expect(requiresRestart(sinHooks, full)).toBe(true)
    expect(restartReasons(bare, full)).toEqual(['desactiva el modo bare', 'vuelve a activar los hooks'])
  })
})

describe('effectiveSystemPrompts', () => {
  const replace = { systemPrompt: { mode: 'replace' as const, text: 'perfil' } }
  const append = { systemPrompt: { mode: 'append' as const, text: 'extra' } }
  test('sin perfil o en modo default no cambia nada', () => {
    expect(effectiveSystemPrompts({ appendSystemPrompt: 'a' }, undefined)).toEqual({ appendSystemPrompt: 'a' })
    expect(effectiveSystemPrompts({}, { systemPrompt: { mode: 'default' } })).toEqual({})
  })
  test('replace rellena custom pero un flag explícito gana', () => {
    expect(effectiveSystemPrompts({}, replace)).toEqual({ customSystemPrompt: 'perfil' })
    expect(effectiveSystemPrompts({ customSystemPrompt: 'cli' }, replace)).toEqual({ customSystemPrompt: 'cli' })
  })
  test('{cwd} se sustituye por el directorio de trabajo', () => {
    const p = { systemPrompt: { mode: 'replace' as const, text: 'Trabaja en {cwd}; no salgas de {cwd}.' } }
    expect(effectiveSystemPrompts({}, p, { cwd: '/w/x' })).toEqual({ customSystemPrompt: 'Trabaja en /w/x; no salgas de /w/x.' })
    expect(effectiveSystemPrompts({}, p)).toEqual({ customSystemPrompt: 'Trabaja en {cwd}; no salgas de {cwd}.' })
  })
  test('append se suma detrás del existente', () => {
    expect(effectiveSystemPrompts({}, append)).toEqual({ appendSystemPrompt: 'extra' })
    expect(effectiveSystemPrompts({ appendSystemPrompt: 'a' }, append)).toEqual({ appendSystemPrompt: 'a\n\nextra' })
  })
})

describe('parsePerfilArgs', () => {
  test('vacío, nombre, nuevo y errores', () => {
    expect(parsePerfilArgs('')).toEqual({ kind: 'list' })
    expect(parsePerfilArgs(' minimo ')).toEqual({ kind: 'use', name: 'minimo' })
    expect(parsePerfilArgs('nuevo mi-perfil')).toEqual({ kind: 'new', name: 'mi-perfil' })
    expect(parsePerfilArgs('help')).toEqual({ kind: 'help' })
    expect(parsePerfilArgs('nuevo').kind).toBe('error')
    expect(parsePerfilArgs('a b').kind).toBe('error')
    expect(parsePerfilArgs('../x').kind).toBe('error')
    expect(parsePerfilArgs('nuevo a/b').kind).toBe('error')
  })
})

describe('perfilFromScope / perfilToJson', () => {
  test('describe la sesión actual y vuelve a parsearse igual', () => {
    const base = ok({ systemPrompt: { mode: 'replace', text: 'hola' }, context: { bare: true } }, 'minimo')
    const p = perfilFromScope('copia', toScope(ok({ tools: ['Read'], context: { mcp: ['r'], skills: false } })), base)
    const again = ok(perfilToJson(p), 'copia')
    expect(again).toEqual(p)
    expect(again.tools).toEqual(['Read'])
    expect(again.context.mcp).toEqual(['r'])
    expect(again.context.bare).toBe(true)
  })
})
