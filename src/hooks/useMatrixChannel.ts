import { useEffect, useRef } from 'react'
import { attachMatrixControls, matrixIdle, matrixSessionStart } from '../utils/matrixEventsRuntime.js'

type Params = {
  /** The prompt can take input: no turn, no local command UI, nothing queued. */
  isIdle: boolean
  /** The session was resumed from an earlier transcript. */
  resumed: boolean
  /** Sends `text` to the REPL as if the user had typed it and pressed Enter. */
  submit: (text: string, uuid: string) => void
  /** Same as pressing Escape. */
  interrupt: () => void
}

/**
 * Glue between the REPL and the Matrix event channel (docs/matrix_events.md):
 * announces `session_start`, attaches the FIFO input and reports idleness so
 * the channel can emit `ready` and flush queued prompts. A no-op unless
 * FNHARNESS_EVENTS or FNHARNESS_INPUT is set.
 */
export function useMatrixChannel({ isIdle, resumed, submit, interrupt }: Params): void {
  const submitRef = useRef(submit)
  const interruptRef = useRef(interrupt)
  submitRef.current = submit
  interruptRef.current = interrupt

  // Declared before the idle effect so `session_start` precedes the first `ready`.
  useEffect(() => {
    // The REPL mounts the MCP manager, so `mcp_settled` will be emitted: announce the capability.
    matrixSessionStart({ resumed, mcp: true })
    return attachMatrixControls({
      submit: (text, uuid) => submitRef.current(text, uuid),
      interrupt: () => interruptRef.current(),
    })
    // Mount only: the session lives as long as the REPL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    matrixIdle(isIdle)
  }, [isIdle])
}
