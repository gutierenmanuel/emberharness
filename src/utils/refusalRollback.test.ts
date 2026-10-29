import { describe, expect, test } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  dropRefusedExchanges,
  normalizeMessagesForAPI,
} from './messages.js'
import { formatRefusalMessage, getErrorMessageIfRefusal } from '../services/api/errors.js'

const refusal = () => getErrorMessageIfRefusal('refusal', 'claude-opus-5-5')!

describe('dropRefusedExchanges', () => {
  test('sin rechazo devuelve la misma lista', () => {
    const msgs = [createUserMessage({ content: 'hola' })]
    expect(dropRefusedExchanges(msgs)).toBe(msgs)
  })

  test('quita prompt, razonamiento, tool_use, tool_result y rechazo; conserva lo anterior', () => {
    const before = [
      createUserMessage({ content: 'primero' }),
      createAssistantMessage({ content: 'respuesta previa' }),
    ]
    const refused = [
      createUserMessage({ content: 'prompt rechazado' }),
      createAssistantMessage({ content: 'pensando' }),
      createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
      }),
      refusal(),
    ]
    const next = [createUserMessage({ content: 'hola' })]
    const out = dropRefusedExchanges([...before, ...refused, ...next])
    expect(out).toEqual([...before, ...next])
  })

  test('otros errores de API no se tratan como rechazo', () => {
    const msgs = [
      createUserMessage({ content: 'a' }),
      createAssistantAPIErrorMessage({ content: 'API Error: overloaded' }),
    ]
    expect(dropRefusedExchanges(msgs)).toBe(msgs)
  })

  test('normalizeMessagesForAPI tras un rechazo solo envía el prompt nuevo', () => {
    const msgs = [
      createUserMessage({ content: 'prompt rechazado' }),
      createAssistantMessage({ content: 'pensando' }),
      refusal(),
      createUserMessage({ content: 'hola' }),
    ]
    const api = normalizeMessagesForAPI(msgs)
    expect(api).toHaveLength(1)
    expect(JSON.stringify(api[0]!.message.content)).toContain('hola')
  })
})

describe('formatRefusalMessage', () => {
  test('muestra categoría y motivo del safeguard', () => {
    const text = formatRefusalMessage('claude-opus-5-5', {
      type: 'refusal',
      category: 'reasoning_extraction',
      explanation: 'bloqueado por ToS',
    })
    expect(text).toContain('Safeguard de la API activado')
    expect(text).toContain('Categoría: reasoning_extraction')
    expect(text).toContain('Motivo: bloqueado por ToS')
  })

  test('sin stop_details lo dice y sigue siendo reconocible como rechazo', () => {
    const msgs = [
      createUserMessage({ content: 'x' }),
      getErrorMessageIfRefusal('refusal', 'claude-opus-5-5')!,
    ]
    expect(JSON.stringify(msgs[1])).toContain('no envió detalle')
    expect(dropRefusedExchanges(msgs)).toEqual([])
  })

  test('el texto con stop_details también dispara el rollback', () => {
    const msgs = [
      createUserMessage({ content: 'x' }),
      getErrorMessageIfRefusal('refusal', 'm', { category: 'c', explanation: 'e' })!,
    ]
    expect(dropRefusedExchanges(msgs)).toEqual([])
  })
})
