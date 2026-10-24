import { useCallback, useEffect, useRef } from 'react'
import { bindAskSubmit, markAskAnswered } from '../utils/matrixEventsRuntime.js'

type Answers = Record<string, string>

/**
 * Matrix event channel, body of the AskUserQuestion dialog
 * (docs/matrix_events.md): lets an `ask_answer` from FNHARNESS_INPUT answer the
 * dialog as if the user had picked the options. Returns the submit function to
 * use in place of the dialog's own, so a submission by either path is recorded
 * as `answered: true` in `ask_user_done`. The `ask_user` / `ask_user_done`
 * events themselves come from `useMatrixPermissionRequest`, in the stable
 * parent. A no-op unless FNHARNESS_EVENTS or FNHARNESS_INPUT is set.
 */
export function useMatrixAskUser(
  toolUseId: string,
  submitAnswers: (answers: Answers) => Promise<void>,
): (answers: Answers) => Promise<void> {
  const submitRef = useRef(submitAnswers)
  submitRef.current = submitAnswers

  const submit = useCallback(
    (answers: Answers) => {
      markAskAnswered(toolUseId)
      return submitRef.current(answers)
    },
    [toolUseId],
  )

  useEffect(() => bindAskSubmit(toolUseId, answers => void submit(answers)), [toolUseId, submit])

  return submit
}
