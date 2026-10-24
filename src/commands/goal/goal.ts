import { getTotalInputTokens, getTotalOutputTokens } from '../../bootstrap/state.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  GOAL_USAGE,
  buildKickoffPrompt,
  formatOutcome,
  formatStatus,
  newGoalState,
  parseGoalArgs,
} from '../../utils/goal/goalLogic.js'
import { getGoal, resolveJudgeAccount, setGoal } from '../../utils/goal/goalState.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseGoalArgs(args)
  const now = Date.now()
  switch (parsed.kind) {
    case 'error':
      onDone(parsed.message, { display: 'system' })
      return null
    case 'status': {
      const state = getGoal()
      onDone(state ? formatStatus(state, now) : `${formatStatus(null, now)}\n\n${GOAL_USAGE}`, {
        display: 'system',
      })
      return null
    }
    case 'clear': {
      const state = getGoal()
      setGoal(null)
      onDone(state ? formatOutcome('cleared', state, now) : 'No había objetivo activo.', {
        display: 'system',
      })
      return null
    }
    case 'set': {
      const judge = resolveJudgeAccount(parsed.judge)
      const state = newGoalState(parsed.condition, { judge, maxTurns: parsed.maxTurns,
        now,
        tokenMark: getTotalInputTokens() + getTotalOutputTokens(),
      })
      setGoal(state)
      onDone(
        `◎ /goal fijado: ${state.condition}\nEvaluador: ${judge ?? 'cuenta activa'} · tope ${state.maxTurns} turnos · /goal para ver el estado, /goal clear para quitarlo`,
        {
          display: 'system',
          shouldQuery: true,
          metaMessages: [buildKickoffPrompt(state.condition)],
        },
      )
      return null
    }
  }
}
