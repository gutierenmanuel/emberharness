/**
 * Lector de los registros `sessions/<pid>.json` de varios directorios de
 * configuración (fnharness y Claude Code conviven en la misma máquina).
 *
 * `udsClient.listAllLiveSessions` solo mira el directorio actual y se queda con
 * los campos de mensajería; el selector necesita todos los registros vivos, de
 * todos los directorios y con el origen que cada sesión escribió. Este lector
 * es independiente de él a propósito: no cambia su contrato.
 */

import { readdir, readFile, realpath } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { isProcessRunning } from '../genericProcessUtils.js'
import type { Harness, RegistryEntry, RegistryRecord } from './types.js'

/** Harness según el nombre del directorio: `.claude*` es Claude Code, el resto fnharness. */
export function harnessOfConfigDir(dir: string): Harness {
  return basename(dir).startsWith('.claude') ? 'claude' : 'fnharness'
}

/**
 * Directorios de configuración candidatos, sin duplicados por realpath y solo
 * los que existen. `homedir()` honra HOME, así los tests aislados no ven los
 * registros reales de la persona.
 */
export async function candidateConfigDirs(): Promise<string[]> {
  const home = homedir()
  const wanted = [
    getClaudeConfigHomeDir(),
    join(home, '.fnharness'),
    join(home, '.claude'),
    // Cuentas Claude extra viven en ~/.claude-<id> (p. ej. ~/.claude-work).
    ...(await readdir(home).catch(() => [] as string[]))
      .filter(name => name.startsWith('.claude-'))
      .sort()
      .map(name => join(home, name)),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of wanted) {
    let real: string
    try {
      real = await realpath(dir)
    } catch {
      continue // no existe
    }
    if (seen.has(real)) continue
    seen.add(real)
    out.push(dir)
  }
  return out
}

/** Registros con proceso vivo de un directorio; los medio escritos o ilegibles se saltan. */
async function readRegistryDir(configDir: string): Promise<RegistryEntry[]> {
  const dir = join(configDir, 'sessions')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const harness = harnessOfConfigDir(configDir)
  const entries = await Promise.all(
    files
      .filter(f => /^\d+\.json$/.test(f))
      .map(async (f): Promise<RegistryEntry | null> => {
        const pid = parseInt(f.slice(0, -5), 10)
        if (!isProcessRunning(pid)) return null
        try {
          const record = JSON.parse(await readFile(join(dir, f), 'utf8')) as RegistryRecord
          if (typeof record !== 'object' || record === null) return null
          // El nombre del fichero manda: es el pid real del proceso.
          return { harness, configDir, record: { ...record, pid } }
        } catch {
          return null
        }
      }),
  )
  return entries.filter((e): e is RegistryEntry => e !== null)
}

/** Registros vivos de todos los directorios candidatos (o de los indicados). */
export async function readRegistryEntries(
  configDirs?: string[],
): Promise<RegistryEntry[]> {
  const dirs = configDirs ?? (await candidateConfigDirs())
  const perDir = await Promise.all(dirs.map(readRegistryDir))
  return perDir.flat()
}
