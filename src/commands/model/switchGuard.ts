/**
 * Runs the PreModelSwitch / PostModelSwitch hooks around a model switch that
 * the user asked for (/model <name>, the /model picker). `apply` performs the
 * switch and is skipped when a Pre hook refuses it.
 */

import { activeAccountId } from '../account/actions.js'
import {
  executePostModelSwitchHooks,
  executePreModelSwitchHooks,
  type ModelSwitchInfo,
} from '../../utils/hooks.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../../utils/model/model.js'

/** Pure: message shown when a Pre hook cancels the switch. */
export function blockedSwitchMessage(
  decision: 'deny' | 'ask',
  reason: string | undefined,
): string {
  const why = reason ? `: ${reason}` : ''
  return decision === 'ask'
    ? `Model switch needs confirmation from a PreModelSwitch hook, which fnharness cannot ask here; kept the current model${why}`
    : `Model switch blocked by a PreModelSwitch hook${why}`
}

function resolveName(model: string | null | undefined): string {
  try {
    return model ? parseUserSpecifiedModel(model) : getDefaultMainLoopModel()
  } catch {
    return model ?? 'default'
  }
}

export async function guardModelSwitch(
  fromModel: string | null | undefined,
  toModel: string | null,
  source: 'command' | 'picker',
  onBlocked: (message: string) => void,
  apply: () => void,
): Promise<void> {
  const account = activeAccountId()
  const info: ModelSwitchInfo = {
    fromModel: resolveName(fromModel),
    toModel: resolveName(toModel),
    requestedModel: toModel,
    source,
    fromAccount: account,
    toAccount: account,
  }
  const d = await executePreModelSwitchHooks(info)
  if (d.decision !== 'allow') {
    onBlocked(blockedSwitchMessage(d.decision, d.reason))
    return
  }
  apply()
  void executePostModelSwitchHooks(info)
}
