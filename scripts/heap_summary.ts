/**
 * Summarises a V8-format heap snapshot (as written by SIGUSR2 with
 * FNHARNESS_MEMDUMP_SNAPSHOT=1 or /heapdump): self size per node type/name,
 * the biggest strings and how many times the same string prefix repeats, and
 * for the biggest strings, a short retainer chain (who holds them).
 *
 *   bun run scripts/heap_summary.ts <file.heapsnapshot> [--top 25]
 */
import { readFileSync } from 'fs'

const file = process.argv[2]
if (!file) throw new Error('usage: heap_summary.ts <file.heapsnapshot>')
const TOP = Number(process.argv[process.argv.indexOf('--top') + 1] || 25) || 25

const snap = JSON.parse(readFileSync(file, 'utf8'))
const meta = snap.snapshot.meta
const nf: string[] = meta.node_fields
const ef: string[] = meta.edge_fields
const nTypes: string[] = meta.node_types[0]
const eTypes: string[] = meta.edge_types[0]
const N = nf.length
const E = ef.length
const nodes: number[] = snap.nodes
const edges: number[] = snap.edges
const strings: string[] = snap.strings
const iType = nf.indexOf('type')
const iName = nf.indexOf('name')
const iSize = nf.indexOf('self_size')
const iEdges = nf.indexOf('edge_count')
const iEType = ef.indexOf('type')
const iEName = ef.indexOf('name_or_index')
const iETo = ef.indexOf('to_node')
const count = nodes.length / N

// Reverse edges (retainers) for a few nodes only, built lazily.
const firstEdge = new Int32Array(count + 1)
for (let i = 0, e = 0; i < count; i++) {
  firstEdge[i] = e
  e += nodes[i * N + iEdges]! * E
}
firstEdge[count] = edges.length

const byKey = new Map<string, { n: number; size: number }>()
const strs: Array<{ idx: number; size: number; name: string }> = []
let total = 0
for (let i = 0; i < count; i++) {
  const t = nTypes[nodes[i * N + iType]!]!
  const name = strings[nodes[i * N + iName]!]!
  const size = nodes[i * N + iSize]!
  total += size
  const key = t === 'string' || t === 'concatenated string' || t === 'sliced string' ? `(${t})` : `${t}:${name.slice(0, 60)}`
  const cur = byKey.get(key) ?? { n: 0, size: 0 }
  cur.n++
  cur.size += size
  byKey.set(key, cur)
  if (t === 'string' && size > 4096) strs.push({ idx: i, size, name })
}
const mb = (b: number) => (b / 1048576).toFixed(1) + 'MB'
console.log(`nodes ${count}  total self size ${mb(total)}`)
console.log('\n== top by self size')
for (const [k, v] of [...byKey].sort((a, b) => b[1].size - a[1].size).slice(0, TOP)) console.log(`${mb(v.size).padStart(9)} ${String(v.n).padStart(8)}  ${k}`)

console.log('\n== big strings grouped by first 80 chars')
const groups = new Map<string, { n: number; size: number; sample: number }>()
for (const s of strs) {
  const k = s.name.slice(0, 80).replace(/\s+/g, ' ')
  const g = groups.get(k) ?? { n: 0, size: 0, sample: s.idx }
  g.n++
  g.size += s.size
  groups.set(k, g)
}
const sortedGroups = [...groups].sort((a, b) => b[1].size - a[1].size).slice(0, TOP)
for (const [k, g] of sortedGroups) console.log(`${mb(g.size).padStart(9)} x${String(g.n).padStart(5)}  ${JSON.stringify(k)}`)

// Retainers for the sample of the top groups.
let retainers: Map<number, Array<[number, string]>> | null = null
function buildRetainers() {
  retainers = new Map()
  for (let i = 0; i < count; i++) {
    for (let e = firstEdge[i]!; e < firstEdge[i + 1]!; e += E) {
      const to = edges[e + iETo]! / N
      const et = eTypes[edges[e + iEType]!]!
      const en = et === 'element' || et === 'hidden' ? `[${edges[e + iEName]}]` : strings[edges[e + iEName]!]!
      let arr = retainers.get(to)
      if (!arr) retainers.set(to, (arr = []))
      if (arr.length < 4) arr.push([i, en])
    }
  }
}
const label = (i: number) => `${nTypes[nodes[i * N + iType]!]}:${strings[nodes[i * N + iName]!]!.slice(0, 40).replace(/\s+/g, ' ')}`
console.log('\n== retainer chains of the top string groups')
buildRetainers()
for (const [k, g] of sortedGroups.slice(0, 8)) {
  console.log(`-- ${JSON.stringify(k.slice(0, 50))}`)
  let cur = g.sample
  const seen = new Set<number>()
  for (let depth = 0; depth < 14; depth++) {
    const r = retainers!.get(cur)
    if (!r || !r.length) break
    const [from, en] = r.find(([f]) => !seen.has(f)) ?? r[0]!
    seen.add(from)
    console.log(`   <- .${en} ${label(from)}${r.length > 1 ? ` (+${r.length - 1})` : ''}`)
    cur = from
  }
}
