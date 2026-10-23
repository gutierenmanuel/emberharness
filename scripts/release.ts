/**
 * Cuts a FnHarness release: bumps package.json `version`, prepends a section
 * to CHANGELOG.md built from the conventional commits since the last tag,
 * commits it as `chore(release): vX.Y.Z` and tags `vX.Y.Z`.
 *
 *   bun run release patch|minor|major
 *
 * `upstreamVersion` (the Claude Code snapshot) is never touched here.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'

export type Bump = 'patch' | 'minor' | 'major'

/** Pure: next SemVer for a bump kind. */
export function bumpVersion(version: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Not a plain SemVer: ${version}`)
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ]
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const SECTIONS: Array<[string, string]> = [
  ['feat', 'Novedades'],
  ['fix', 'Correcciones'],
  ['refactor', 'Refactor'],
  ['docs', 'Documentación'],
  ['test', 'Tests'],
]

/** Pure: Markdown section for a release from `git log --format=%s` lines. */
export function renderChangelogSection(
  version: string,
  date: string,
  subjects: string[],
): string {
  const lines = [`## v${version} (${date})`, '']
  for (const [type, title] of SECTIONS) {
    const items = subjects
      .map(s => /^(\w+)(\([^)]*\))?!?:\s*(.+)$/.exec(s))
      .filter((m): m is RegExpExecArray => m !== null && m[1] === type)
      .map(m => `- ${m[3]}`)
    if (items.length > 0) lines.push(`### ${title}`, '', ...items, '')
  }
  if (lines.length === 2) lines.push('- Sin cambios relevantes.', '')
  return lines.join('\n')
}

function git(args: string[]): string {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(proc.stderr)}`)
  }
  return new TextDecoder().decode(proc.stdout).trim()
}

function lastTag(): string | null {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*'])
  } catch {
    return null
  }
}

function main(): void {
  const bump = process.argv[2] as Bump
  if (!['patch', 'minor', 'major'].includes(bump)) {
    console.error('Uso: bun run release patch|minor|major')
    process.exit(1)
  }
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    console.error('Hay cambios sin confirmar: commitea antes de publicar una versión.')
    process.exit(1)
  }

  const pkgPath = 'package.json'
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  const next = bumpVersion(pkg.version, bump)
  const tag = lastTag()
  const subjects = git(['log', '--format=%s', ...(tag ? [`${tag}..HEAD`] : [])])
    .split('\n')
    .filter(Boolean)
  // Local calendar date (toISOString is UTC and slips a day around midnight).
  const date = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const header = '# Changelog de FnHarness\n\n'
  const previous = existsSync('CHANGELOG.md')
    ? readFileSync('CHANGELOG.md', 'utf8').replace(header, '')
    : ''
  writeFileSync('CHANGELOG.md', header + renderChangelogSection(next, date, subjects) + '\n' + previous)
  writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(`"version": "${pkg.version}"`, `"version": "${next}"`))

  git(['add', 'package.json', 'CHANGELOG.md'])
  git(['commit', '-m', `chore(release): v${next}`])
  git(['tag', '-a', `v${next}`, '-m', `FnHarness v${next}`])
  console.log(`FnHarness ${pkg.version} → ${next} (tag v${next}). Recompila con: bun run build`)
}

if (import.meta.main) main()
