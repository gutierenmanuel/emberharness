export type SkillsDiff = { added: string[]; removed: string[]; total: number }

/** Pure: which skill names appeared or disappeared between two scans. */
export function diffSkillNames(
  before: readonly string[],
  after: readonly string[],
): SkillsDiff {
  const b = new Set(before)
  const a = new Set(after)
  return {
    added: [...a].filter(n => !b.has(n)).sort(),
    removed: [...b].filter(n => !a.has(n)).sort(),
    total: a.size,
  }
}

export function formatReloadSkillsMessage(d: SkillsDiff): string {
  const parts = [`Reloaded ${d.total} ${d.total === 1 ? 'skill' : 'skills'}`]
  if (d.added.length) parts.push(`new: ${d.added.join(', ')}`)
  if (d.removed.length) parts.push(`gone: ${d.removed.join(', ')}`)
  if (!d.added.length && !d.removed.length) parts.push('no changes')
  return parts.join(' · ')
}
