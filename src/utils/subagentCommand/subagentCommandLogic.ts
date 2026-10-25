// Pure logic behind `/fork` and `/subtask`: argument parsing and the meta
// instruction that makes the model launch the background subagent through the
// Agent tool. No I/O, so it is unit-testable.

export type SubagentMode = 'fork' | 'subtask'

export type SubagentArgs =
  | { kind: 'run'; directive: string; model: string | null }
  | { kind: 'error'; message: string }

export function subagentUsage(mode: SubagentMode): string {
  const what =
    mode === 'fork'
      ? 'Lanza un subagente en segundo plano que hereda TODA la conversación actual y trabaja la instrucción.'
      : 'Lanza un subagente en segundo plano con contexto limpio (sin el historial): solo ve la instrucción.'
  return `Uso: /${mode} [--model <modelo|cuenta:modelo>] <instrucción>

${what}

  /${mode} revisa los tests de src/utils y dime qué falla
  /${mode} --model claude:haiku cuenta los ficheros de src/
  --model <m>   modelo del subagente: sonnet, opus, haiku o cuenta:modelo (por defecto, el de la sesión)`
}

/** Parse raw `/fork` / `/subtask` arguments. `--model` may appear anywhere. */
export function parseSubagentArgs(raw: string, mode: SubagentMode): SubagentArgs {
  const tokens = raw.trim().split(/\s+/).filter(t => t !== '')
  const rest: string[] = []
  let model: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const eq = /^--model=(.*)$/.exec(tok)
    if (eq === null && tok !== '--model') {
      rest.push(tok)
      continue
    }
    const value = eq ? eq[1]! : tokens[++i]
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { kind: 'error', message: `Falta el valor de --model.\n\n${subagentUsage(mode)}` }
    }
    model = value
  }
  const directive = rest.join(' ').trim()
  if (directive === '') {
    return { kind: 'error', message: `Falta la instrucción.\n\n${subagentUsage(mode)}` }
  }
  return { kind: 'run', directive, model }
}

/** Meta message sent to the model: it must answer with one Agent tool call. */
export function buildSubagentPrompt(mode: SubagentMode, directive: string, model: string | null): string {
  const params = [
    mode === 'fork' ? 'subagent_type: "fork"' : 'subagent_type: "general-purpose"',
    'run_in_background: true',
    ...(model ? [`model: ${JSON.stringify(model)}`] : []),
    'description: a short 3-5 word summary of the instruction',
    mode === 'fork'
      ? 'prompt: the instruction below, verbatim'
      : 'prompt: a self-contained brief for the agent, which sees NOTHING of this conversation: include every path, constraint and fact from the instruction below that it needs, and nothing else',
  ]
  const lead =
    mode === 'fork'
      ? 'The user ran /fork: start a forked background subagent that inherits this whole conversation.'
      : 'The user ran /subtask: start a background subagent with a clean context (no conversation history, only its prompt).'
  return `${lead}
Call the Agent tool exactly once, right now, with these parameters:
${params.map(p => `- ${p}`).join('\n')}
Do not do the work yourself and do not call any other tool. After the Agent call returns, reply with a single short sentence saying the subagent was launched in the background; you will be notified when it finishes.

Instruction:
${directive}`
}
