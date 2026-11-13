/**
 * Cola legible del transcript de una sesión, para el detalle del selector.
 *
 * `tailFromJsonl` es puro: toma el texto de la cola de un `.jsonl` y devuelve las
 * últimas líneas de conversación (`> usuario`, `· asistente`, `[herramienta]`).
 * `readTranscriptTail` es el borde: localiza el fichero (en el directorio de
 * configuración propio y en el de la fila) y lee solo los últimos 64 KB.
 */

import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { resolveSessionFilePath } from '../sessionStoragePortable.js'
import type { SessionRow } from './types.js'

const WINDOW_BYTES = 64 * 1024

type Block = { type?: string; text?: string; name?: string }

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function textsOf(content: unknown): { text: string[]; tools: string[] } {
  if (typeof content === 'string') return { text: [content], tools: [] }
  if (!Array.isArray(content)) return { text: [], tools: [] }
  const text: string[] = []
  const tools: string[] = []
  for (const b of content as Block[]) {
    if (b?.type === 'text' && typeof b.text === 'string') text.push(b.text)
    else if (b?.type === 'tool_use' && b.name) tools.push(b.name)
  }
  return { text, tools }
}

/** Últimas `max` líneas de conversación de un trozo de `.jsonl` (la primera línea puede venir cortada). */
export function tailFromJsonl(text: string, max: number, partialStart = false): string[] {
  const lines = text.split('\n')
  if (partialStart) lines.shift()
  const out: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let obj: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.isSidechain || obj.isMeta) continue
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    const { text: texts, tools } = textsOf(obj.message?.content)
    const joined = texts.join(' ')
    if (obj.type === 'user') {
      if (joined && !joined.startsWith('<')) out.push(`> ${oneLine(joined)}`)
    } else {
      if (joined) out.push(`· ${oneLine(joined)}`)
      for (const t of tools) out.push(`[${t}]`)
    }
  }
  return out.slice(-max)
}

async function findTranscript(row: SessionRow): Promise<string | undefined> {
  if (!row.sessionId) return undefined
  const viaResolver = await resolveSessionFilePath(row.sessionId, row.cwd).catch(() => undefined)
  if (viaResolver) return viaResolver.filePath
  if (!row.configDir) return undefined
  const projects = join(row.configDir, 'projects')
  try {
    for (const d of await readdir(projects)) {
      const p = join(projects, d, `${row.sessionId}.jsonl`)
      try {
        if ((await stat(p)).size > 0) return p
      } catch {
        // no está en este proyecto
      }
    }
  } catch {
    // sin directorio de proyectos
  }
  return undefined
}

/** Cola del transcript de la fila; vacía si no se encuentra. */
export async function readTranscriptTail(row: SessionRow, max = 12): Promise<string[]> {
  const path = await findTranscript(row)
  if (!path) return []
  try {
    const fh = await open(path, 'r')
    try {
      const size = (await fh.stat()).size
      const start = Math.max(0, size - WINDOW_BYTES)
      const buf = Buffer.alloc(size - start)
      await fh.read(buf, 0, buf.length, start)
      return tailFromJsonl(buf.toString('utf8'), max, start > 0)
    } finally {
      await fh.close()
    }
  } catch {
    return []
  }
}
