import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { requestRestart } from '../../utils/perfilRestart.js'
import {
  applySessionConfig,
  normalizeValue,
  readSessionConfig,
  requiresConfirmation,
  SESSION_CONFIG_OPS,
  type SessionConfigHost,
  type SessionConfigResult,
} from '../../utils/sessionConfig.js'

export const SESSION_CONFIG_TOOL_NAME = 'SessionConfig'

const DESCRIPTION = 'Read or change the settings of THIS session in place (model, effort, thinking, permission mode, profile)'

const PROMPT = `Read or change settings of the current fnharness session without the person typing anything. Changes apply to this session only and are never saved to the user's settings.

Input: \`op\` and, to change it, \`value\`. Allowed ops (anything else is rejected):
- \`get\` — returns the current model, effort, thinking, permissionMode and perfil.
- \`model\` — alias or model name (e.g. "sonnet", "opus"). Used from the next turn.
- \`effort\` — low | medium | high | max | auto.
- \`thinking\` — on | off.
- \`permissionMode\` — default | plan | acceptEdits | dontAsk | auto | bypassPermissions. Raising permissions (acceptEdits, dontAsk, auto, bypassPermissions) asks the person first.
- \`perfil\` — name of a /perfil profile. Always asks the person first; if it cannot apply live the session restarts.

Reading and lowering model/effort need no confirmation. If the person asks for a change on ANOTHER session, do not use this tool: send it a control message over its socket instead.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe(`"get" or one of: ${SESSION_CONFIG_OPS.join(', ')}`),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe('New value; omit with op "get"'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Output = { result?: SessionConfigResult; state?: Record<string, string | boolean>; error?: string }

export const SessionConfigTool = buildTool({
  name: SESSION_CONFIG_TOOL_NAME,
  searchHint: 'change this session settings: model, effort, thinking, permission mode, profile',
  maxResultSizeChars: 20_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  userFacingName() {
    return 'SessionConfig'
  },
  shouldDefer: true,
  isEnabled() {
    return process.env.FNHARNESS_SESSION_CONFIG === '1'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.op === 'get'
  },
  toAutoClassifierInput(input) {
    return `${input.op} ${input.value ?? ''}`.trim()
  },
  async checkPermissions(input) {
    if (input.op === 'get') return { behavior: 'allow' as const, updatedInput: input }
    const norm = normalizeValue(input.op, input.value)
    // Un valor o clave inválidos se rechazan en call(); no hay nada que confirmar.
    if (norm.ok === false || !requiresConfirmation(input.op, norm.value)) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return { behavior: 'ask' as const, message: `Cambiar ${input.op} de esta sesión a ${String(norm.value)}` }
  },
  renderToolUseMessage(input: Partial<z.infer<InputSchema>>) {
    return input.op === 'get' ? 'get' : `${input.op ?? ''} = ${String(input.value ?? '')}`
  },
  async call(input, context) {
    // El contexto de la tool trae el store de la sesión: es el mismo que usa el socket.
    const host: SessionConfigHost = { getAppState: context.getAppState, setAppState: context.setAppState }
    if (input.op === 'get') return { data: { state: readSessionConfig(host.getAppState()) } }
    const result = await applySessionConfig({ op: input.op, value: input.value, origin: 'tool', confirmed: true }, host)
    if (result.restart && 'args' in result.restart) {
      const { args } = result.restart
      // Deja que el resultado de la tool llegue al modelo antes de cerrar.
      setTimeout(() => void requestRestart(args), 1500).unref?.()
    }
    return { data: { result } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { result, state } = content as Output
    let body: string
    if (state) body = JSON.stringify(state)
    else if (!result) body = 'Sin resultado'
    else if (!result.ok) body = `Rechazado: ${result.error}`
    else body = `${result.message ?? 'Hecho'} (${result.op}: ${String(result.from)} -> ${String(result.to)})`
    return { tool_use_id: toolUseID, type: 'tool_result', content: body, ...(result && !result.ok ? { is_error: true } : {}) }
  },
} satisfies ToolDef<InputSchema, Output>)
