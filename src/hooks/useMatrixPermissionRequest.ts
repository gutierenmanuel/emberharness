import { useEffect } from 'react'
import { toAskQuestions, truncate } from '../utils/matrixEvents.js'
import { announceAskDialog, emitMatrix } from '../utils/matrixEventsRuntime.js'

type Request = {
  toolUseID: string
  description: string
  input: unknown
  isAskUserQuestion: boolean
  toolName: string
}

/**
 * Matrix event channel for permission requests (docs/matrix_events.md). Lives in
 * the stable parent of every permission dialog: AskUserQuestion reports
 * `ask_user` / `ask_user_done`, any other tool reports `permission_prompt`.
 * With bypass permissions no dialog is shown, so nothing is emitted.
 * A no-op unless FNHARNESS_EVENTS or FNHARNESS_INPUT is set.
 */
export function useMatrixPermissionRequest(req: Request): void {
  useEffect(() => {
    if (req.isAskUserQuestion) {
      const questions = (req.input as { questions?: Parameters<typeof toAskQuestions>[0] } | undefined)?.questions
      return announceAskDialog(req.toolUseID, toAskQuestions(questions ?? []))
    }
    emitMatrix({
      type: 'permission_prompt',
      tool_use_id: req.toolUseID,
      tool: req.toolName,
      summary: truncate(req.description, 200),
    })
    return undefined
    // One event per dialog (per tool use), not per re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.toolUseID])
}
