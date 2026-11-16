/**
 * Spoken session aliases (animal + color, "🦊 zorro rojo"): reading the registry written by
 * `python/functions/infra/get_session_alias.py` and matching what a person
 * says ("zorro", "zorrito", "gatita", "zorrito rojo") against it.
 *
 * Kept free of imports from udsClient / udsMessaging so it can be unit-tested
 * and loaded from the system prompt without side effects. The animal catalog
 * is never hard-coded here: matching works from whatever the registry holds.
 */
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type SessionAlias = {
  animal: string
  adjective: string
  emoji: string
  alias: string
  /** "#RRGGBB" of the alias color; absent in registry entries written before colors existed. */
  color?: string
}

const REGISTRY_FILE = 'fnharness-session-names.json'

/** Path of the pid -> alias registry (same rule as get_session_alias.py). */
export function sessionAliasRegistryPath(runtimeDir?: string): string {
  const base = runtimeDir || process.env.XDG_RUNTIME_DIR || tmpdir()
  return join(base, REGISTRY_FILE)
}

/** starttime (field 22) of /proc/<pid>/stat, '' when the process is gone. */
function procStartTicks(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? ''
  } catch {
    return ''
  }
}

/**
 * pid -> alias for every live session in the registry. Tolerant: a missing or
 * corrupt file gives an empty map; entries of dead or recycled pids (the
 * recorded `start` differs from /proc) are ignored.
 */
export function readSessionAliases(
  opts: { runtimeDir?: string; startTicks?: (pid: number) => string } = {},
): Map<number, SessionAlias> {
  const out = new Map<number, SessionAlias>()
  let data: unknown
  try {
    data = JSON.parse(readFileSync(sessionAliasRegistryPath(opts.runtimeDir), 'utf8'))
  } catch {
    return out
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  const ticks = opts.startTicks ?? procStartTicks
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.animal !== 'string' || typeof e.alias !== 'string') continue
    const pid = Number(key)
    const start = ticks(pid)
    if (!start || e.start !== start) continue
    out.set(pid, {
      animal: e.animal,
      adjective: typeof e.adjective === 'string' ? e.adjective : '',
      emoji: typeof e.emoji === 'string' ? e.emoji : '',
      alias: e.alias,
      ...(typeof e.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(e.color) ? { color: e.color } : {}),
    })
  }
  return out
}

/** Alias of this very session, when the status line has already assigned one. */
export function getOwnSessionAlias(pid = process.pid): SessionAlias | undefined {
  return readSessionAliases().get(pid)
}

/** Lowercase, no accents, collapsed spaces. */
export function stripAccents(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Prefixes people put in front of the name: "claude", "al", "a", "el", "la"... */
const FILLER = new Set(['claude', 'al', 'a', 'el', 'la', 'los', 'las', 'del'])

/** Normalize a spoken reference to its bare words ("A la gatita" -> "gatita"). */
export function normalizeAliasRef(ref: string): string {
  const words = stripAccents(ref).replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean)
  while (words.length > 1 && FILLER.has(words[0]!)) words.shift()
  return words.join(' ')
}

const DIMINUTIVES = [
  'ecitos', 'ecitas', 'ecito', 'ecita',
  'citos', 'citas', 'cito', 'cita',
  'itos', 'itas', 'ito', 'ita',
  'illos', 'illas', 'illo', 'illa',
]

/**
 * Forms a single spoken word can stand for: itself plus, for every diminutive
 * suffix it ends in, the base and the base with -o / -a ("zorrito" ->
 * "zorrito", "zorr", "zorro", "zorra"; "ratoncito" -> "raton", "ratono"...).
 * Pure; the caller compares the forms with the registry's own animals.
 */
export function diminutiveForms(word: string): string[] {
  const w = stripAccents(word)
  const forms = new Set<string>([w])
  for (const suf of DIMINUTIVES) {
    if (w.length > suf.length + 1 && w.endsWith(suf)) {
      const base = w.slice(0, -suf.length)
      forms.add(base)
      forms.add(base + 'o')
      forms.add(base + 'a')
    }
  }
  return [...forms]
}

/** rojo/roja are the same adjective for matching purposes. */
function sameAdjective(a: string, b: string): boolean {
  const x = stripAccents(a)
  const y = stripAccents(b)
  return x === y || (x.length > 2 && x.replace(/[oa]$/, '') === y.replace(/[oa]$/, ''))
}

export type AliasCandidate = { animal?: string; adjective?: string; alias?: string }

/**
 * Candidates a spoken ref designates. A full-alias match wins alone; otherwise
 * every candidate whose animal equals the ref's animal (or a diminutive-derived
 * form of it), optionally followed by its adjective, matches. Multi-word
 * animals are supported because the animal's word count comes from the
 * candidate itself.
 */
export function matchAliasRef<T extends AliasCandidate>(ref: string, candidates: T[]): T[] {
  const norm = normalizeAliasRef(ref)
  if (!norm) return []
  const exact = candidates.filter(c => c.alias && stripAccents(c.alias) === norm)
  if (exact.length > 0) return exact
  const tokens = norm.split(' ')
  return candidates.filter(c => {
    if (!c.animal) return false
    const animal = stripAccents(c.animal)
    const k = animal.split(' ').length
    if (tokens.length < k) return false
    const [first, ...restAnimal] = tokens.slice(0, k)
    const forms = diminutiveForms(first!).map(f => [f, ...restAnimal].join(' '))
    if (!forms.includes(animal)) return false
    const adj = tokens.slice(k).join(' ')
    return adj === '' || (!!c.adjective && sameAdjective(adj, c.adjective))
  })
}
