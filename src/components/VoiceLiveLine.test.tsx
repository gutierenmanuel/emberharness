import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToString } from '../utils/staticRender.js'
import { clearCommandQueue, enqueue } from '../utils/messageQueueManager.js'
import { buildVoiceCommand } from '../utils/voiceListenRuntime.js'
import { voiceLiveFragment, voiceLiveReady, voiceLiveReset, voiceLiveSent } from '../utils/voiceLiveState.js'
import { VoiceLiveLine } from './VoiceLiveLine.js'

afterEach(() => {
  voiceLiveReset()
  clearCommandQueue()
})

const show = () => renderToString(<VoiceLiveLine />, 100)

describe('VoiceLiveLine', () => {
  test('sin escucha no pinta nada', async () => {
    expect((await show()).trim()).toBe('')
  })

  test('escuchando, dictando con el texto en vivo, enviado y en cola', async () => {
    voiceLiveReady()
    expect(await show()).toContain('escuchando')
    voiceLiveFragment({ text: 'quiero que mires', mic: 'omi' })
    voiceLiveFragment({ text: 'el panel', mic: 'omi' })
    const dictating = await show()
    expect(dictating).toContain('dictando')
    expect(dictating).toContain('quiero que mires el panel')
    voiceLiveSent(25)
    expect(await show()).toContain('enviado')
    enqueue(buildVoiceCommand('quiero que mires el panel', 'omi'))
    const queued = await show()
    expect(queued).toContain('en cola')
    expect(queued).not.toContain('quiero que mires') // el texto ya está en la cola de abajo, no se repite
  })
})
