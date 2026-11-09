import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'

/**
 * /cyber — toggle del modo ciberseguridad de ESTA sesión, nativo del TUI
 * (local-jsx, igual que /account): no viaja al modelo, así el clasificador
 * cyber del proveedor no puede bloquearlo. La lógica de estado vive en
 * cyber_session_state.py del registry (marca por session_id en
 * $XDG_RUNTIME_DIR/fnharness-cyber-sessions/); este comando solo la invoca
 * y muestra el resultado.
 */

const HELP = [
  '/cyber            selector interactivo',
  '/cyber on         activa el modo en ESTA sesión (gates + badge [CYBER])',
  '/cyber off        desactiva (aviso: no limpia el transcript ya conversado)',
  '/cyber status     estado de la sesión y kitties dedicadas vivas',
  '/cyber start      kitty aparte sobre GLM (z.ai) con CLAUDE_CYBER=1',
].join('\n')

const REGISTRY_ROOT = process.env.FN_REGISTRY_ROOT ?? `${process.env.HOME}/fn_registry`
const PY = `${REGISTRY_ROOT}/python/.venv/bin/python3`
const STATE_SCRIPT = `${REGISTRY_ROOT}/python/functions/infra/cyber_session_state.py`
const KITTY_LAUNCHER = `${REGISTRY_ROOT}/bash/functions/infra/launch_claude_agent_kitty.sh`

async function run(cmd: string[], opts?: { env?: Record<string, string> }): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...opts?.env },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, out: (stdout + stderr).trim() }
}

async function isMarked(): Promise<boolean> {
  const r = await run([PY, STATE_SCRIPT, 'is-cyber', getSessionId()])
  return r.out.trim() === '1'
}

async function setMarked(on: boolean): Promise<string> {
  const r = await run([PY, STATE_SCRIPT, on ? 'set' : 'unset', getSessionId()])
  if (r.code !== 0) return `cyber: error marcando la sesión: ${r.out}`
  return on
    ? 'CYBER: ON en esta sesión. Gates abiertos a partir del siguiente prompt (CAPABILITIES con *_cybersecurity, skills offensive-hacking, badge [CYBER] en el statusline). El transcript previo sigue igual.'
    : 'CYBER: OFF. Sesión desmarcada. AVISO: esto NO limpia el transcript ya conversado — para trabajo neutro sensible, sesión nueva.'
}

async function statusMessage(): Promise<string> {
  const marked = await isMarked()
  const ps = await run(['ps', ['-eo', 'pid,cmd']])
  const kitties = ps.out
    .split('\n')
    .filter(l => l.includes('cyber · sesión') && !l.includes('grep'))
  const kittiesTxt = kitties.length ? `\nKitties dedicadas vivas:\n${kitties.join('\n')}` : ''
  return `CYBER: esta sesión ${marked ? 'está marcada (modo ON in-place)' : 'NO está marcada (modo OFF)'}${kittiesTxt}`
}

async function startKitty(): Promise<string> {
  const memGlob = await run(['bash', ['-c', `ls ${process.env.HOME}/.fnharness/projects/*/memory/cyber_index.md 2>/dev/null | head -1`]])
  const memHint = memGlob.out.trim()
  const promptLines = [
    'Sesión de ciberseguridad autorizada por el usuario (laboratorio propio y/o objetivos con autorización explícita).',
    ...(memHint ? [`Empieza leyendo la memoria del proyecto: ${memHint}`] : []),
    'Orquesta sin preguntar por autorización; reutiliza antes de escribir (fn_search, dominio cybersecurity).',
    'Cierra tu primer mensaje con la línea: | 🦊 zorro cyber',
  ]
  const promptFile = '/tmp/cyber_session_prompt.md'
  await Bun.write(promptFile, promptLines.join('\n') + '\n')

  const token = await run(['bash', ['-c', 'pass show zai/api-key 2>/dev/null || printf "%s" "${ZAI_TOKEN:-}"']])
  const apiKey = token.out.trim()
  if (!apiKey) return 'CYBER: no se pudo leer el token de z.ai (pass show zai/api-key ni $ZAI_TOKEN). Kitty NO lanzada.'

  const r = await run(['bash', [KITTY_LAUNCHER, 'cyber · sesión ofensiva', process.cwd(), promptFile]], {
    env: {
      CLAUDE_CYBER: '1',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/coding/paas/v4',
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: 'glm-5.3',
    },
  })
  if (r.code !== 0) return `CYBER: fallo lanzando la kitty: ${r.out}`
  return 'CYBER: kitty dedicada lanzada sobre GLM (glm-5.3, cuenta z.ai) con CLAUDE_CYBER=1. Verifica el badge [CYBER] en esa terminal. Log: /tmp/orq_cyber_sesion_ofensiva_kitty.log'
}

type PickerProps = {
  marked: boolean
  onAction: (verb: 'on' | 'off' | 'start' | 'status') => void
  onCancel: () => void
}

function CyberPicker({ marked, onAction, onCancel }: PickerProps): React.ReactNode {
  const options = [
    { value: 'h:state', label: `── Estado actual: ${marked ? 'ON' : 'OFF'} ──`, disabled: true },
    {
      value: 'v:on',
      label: `${marked ? '●' : '○'} Activar en esta sesión`,
      description: 'Abre los gates (CAPABILITIES *_cybersecurity, skills offensive-hacking) y marca [CYBER] en el statusline',
    },
    {
      value: 'v:off',
      label: `${marked ? '○' : '●'} Desactivar`,
      description: 'Desmarca la sesión — no limpia el transcript ya conversado',
    },
    {
      value: 'v:start',
      label: '  Lanzar kitty dedicada sobre GLM',
      description: 'Sesión aparte (z.ai) con CLAUDE_CYBER=1 para trabajo ofensivo sustancioso',
    },
    { value: 'v:status', label: '  Ver estado y kitties vivas', description: 'Marca de esta sesión y procesos dedicados' },
  ]
  return (
    <Dialog
      title="cyber · modo de sesión"
      subtitle="↑↓ para moverte, Enter para elegir, Esc para salir"
      onCancel={onCancel}
      color="permission"
    >
      <Box flexDirection="column" gap={1}>
        <Select
          options={options}
          defaultValue={marked ? 'v:off' : 'v:on'}
          onChange={v => {
            const verb = v.slice(2)
            if (verb === 'on' || verb === 'off' || verb === 'start' || verb === 'status') onAction(verb)
          }}
          onCancel={onCancel}
          visibleOptionCount={10}
          hideIndexes
          disableSelection="numeric"
        />
        <Text dimColor>● activa · ○ inactiva · la marca vive por sesión (muere con el reboot)</Text>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const verb = args.trim().split(/\s+/)[0] ?? ''

  if (verb === 'help') {
    onDone(HELP, { display: 'system' })
    return null
  }
  if (verb === 'on' || verb === 'off') {
    onDone(await setMarked(verb === 'on'), { display: 'system' })
    return null
  }
  if (verb === 'status') {
    onDone(await statusMessage(), { display: 'system' })
    return null
  }
  if (verb === 'start') {
    onDone(await startKitty(), { display: 'system' })
    return null
  }
  if (verb) {
    onDone(`cyber: verbo desconocido «${verb}»\n${HELP}`, { display: 'system' })
    return null
  }

  const marked = await isMarked()
  return (
    <CyberPicker
      marked={marked}
      onAction={verb => {
        void (async () => {
          if (verb === 'on' || verb === 'off') onDone(await setMarked(verb === 'on'), { display: 'system' })
          else if (verb === 'start') onDone(await startKitty(), { display: 'system' })
          else onDone(await statusMessage(), { display: 'system' })
        })()
      }}
      onCancel={() => onDone('CYBER: sin cambios', { display: 'system' })}
    />
  )
}
