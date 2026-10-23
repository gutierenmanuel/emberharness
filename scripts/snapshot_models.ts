/**
 * Regenerates src/services/api/openai-compat/catalog.snapshot.json, the
 * offline fallback of the models.dev catalog, trimmed to OpenAI-compatible
 * providers and the fields fnharness reads.
 *
 *   bun run scripts/snapshot_models.ts [ruta/api.json | URL]
 *
 * Defaults to downloading https://models.dev/api.json.
 */
import { writeFileSync } from 'fs'
import { trimCatalog } from '../src/services/api/openai-compat/catalog.ts'

const source = process.argv[2] ?? 'https://models.dev/api.json'
const raw = /^https?:/.test(source)
  ? await (await fetch(source)).json()
  : await Bun.file(source).json()

const trimmed = trimCatalog(raw)
const out = new URL('../src/services/api/openai-compat/catalog.snapshot.json', import.meta.url)
const text = JSON.stringify(trimmed)
writeFileSync(out, text + '\n')

const models = Object.values(trimmed).reduce((n, p) => n + Object.keys(p.models ?? {}).length, 0)
console.log(
  `snapshot: ${Object.keys(trimmed).length} proveedores, ${models} modelos, ${(text.length / 1e6).toFixed(2)} MB`,
)
