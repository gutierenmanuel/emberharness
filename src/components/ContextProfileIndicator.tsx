/**
 * Footer pill for the context profile (`ctx: simple · ~3k tok`) plus the
 * Ctrl+Tab / Ctrl+Shift+Tab bindings that rotate it. Lives in its own file so
 * the footer only needs one extra element.
 */

import * as React from 'react'
import { useIsModalOverlayActive } from '../context/overlayContext.js'
import { Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js'
import {
  FULL_PROFILE,
  cycleProfile,
  formatProfile,
  formatProfileShort,
  formatTokenEstimate,
} from '../utils/contextProfile.js'
import { applyContextProfile } from '../utils/contextProfileStore.js'

export function ContextProfileIndicator(): React.ReactNode {
  const profile = useAppState(s => s.contextProfile) ?? FULL_PROFILE
  const mcpTools = useAppState(s => s.mcp.tools)
  const model = useAppState(s => s.mainLoopModel)
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const overlay = useIsModalOverlayActive()
  // Estimate tagged with the profile it belongs to, so a stale number is
  // never shown next to a freshly selected profile.
  const [estimate, setEstimate] = React.useState<{ key: string; tokens: number } | null>(null)
  const key = formatProfile(profile)

  const cycle = React.useCallback(
    (dir: 1 | -1) => {
      const current = store.getState().contextProfile ?? FULL_PROFILE
      applyContextProfile(setAppState, cycleProfile(current, dir))
    },
    [store, setAppState],
  )
  useKeybinding('chat:cycleContextProfile', () => cycle(1), { context: 'Chat', isActive: !overlay })
  useKeybinding('chat:cycleContextProfileBack', () => cycle(-1), { context: 'Chat', isActive: !overlay })

  React.useEffect(() => {
    let alive = true
    // Lazy: the estimator pulls in the prompt builder and the command list.
    void import('../utils/contextProfileEstimate.js').then(async m => {
      const est = await m.estimateContextProfile(store.getState(), profile)
      if (alive) setEstimate({ key, tokens: est.total })
    })
    return () => {
      alive = false
    }
  }, [key, profile, mcpTools, model, store])
  const tokens = estimate?.key === key ? estimate.tokens : null

  return (
    <Text dimColor>
      {' · ctx: '}
      {formatProfileShort(profile)}
      {tokens ? ` ${formatTokenEstimate(tokens)}` : ''}
    </Text>
  )
}
