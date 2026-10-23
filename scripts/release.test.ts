import { describe, expect, test } from 'bun:test'
import { bumpVersion, renderChangelogSection } from './release.js'

describe('bumpVersion', () => {
  test('patch, minor and major', () => {
    expect(bumpVersion('0.5.0', 'patch')).toBe('0.5.1')
    expect(bumpVersion('0.5.3', 'minor')).toBe('0.6.0')
    expect(bumpVersion('0.5.3', 'major')).toBe('1.0.0')
  })

  test('rejects non-plain versions', () => {
    expect(() => bumpVersion('2.1.87-dev', 'patch')).toThrow()
  })
})

describe('renderChangelogSection', () => {
  test('groups conventional commits by type and drops the rest', () => {
    const out = renderChangelogSection('0.6.0', '24/10/2026', [
      'feat(ui): cabecera compacta',
      'fix: contador de monitors',
      'chore(release): v0.5.0',
      'docs(plans): roadmap',
    ])
    expect(out).toContain('## v0.6.0 (24/10/2026)')
    expect(out).toContain('### Novedades\n\n- cabecera compacta')
    expect(out).toContain('### Correcciones\n\n- contador de monitors')
    expect(out).toContain('### Documentación\n\n- roadmap')
    expect(out).not.toContain('release')
  })

  test('says so when there is nothing to list', () => {
    expect(renderChangelogSection('0.5.1', '24/10/2026', ['chore: x'])).toContain(
      'Sin cambios relevantes.',
    )
  })
})
