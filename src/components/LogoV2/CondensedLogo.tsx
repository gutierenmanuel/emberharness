import * as React from 'react'
import { useEffect } from 'react'
import { useConnectedSummary } from '../../hooks/useConnectedSummary.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { formatConnectedLine } from '../../services/api/openai-compat/connected.js'
import { getMultimodelProfile } from '../../services/api/openai-compat/profiles.js'
import { useAppState } from '../../state/AppState.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { truncate } from '../../utils/format.js'
import { formatModelAndBilling, getLogoDisplayData, truncatePath } from '../../utils/logoV2Utils.js'
import { renderModelSetting } from '../../utils/model/model.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { ANIM_WIDTH, FnLogo, SMALL_LOGO_WIDTH } from './FnLogo.js'
import { GuestPassesUpsell, incrementGuestPassesSeenCount, useShowGuestPassesUpsell } from './GuestPassesUpsell.js'
import { incrementOverageCreditUpsellSeenCount, OverageCreditUpsell, useShowOverageCreditUpsell } from './OverageCreditUpsell.js'

// Plain TSX (no React Compiler cache) so the header can grow lines without
// hand-editing memo slots.
export function CondensedLogo(): React.ReactNode {
  const { columns } = useTerminalSize()
  const agent = useAppState(s => s.agent)
  const effortValue = useAppState(s => s.effortValue)
  const model = useMainLoopModel()
  const modelDisplayName = renderModelSetting(model)
  const { version, cwd, billingType, agentName: agentNameFromSettings } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const showGuestPassesUpsell = useShowGuestPassesUpsell()
  const showOverageCreditUpsell = useShowOverageCreditUpsell()
  const connected = useConnectedSummary()

  useEffect(() => {
    if (showGuestPassesUpsell) incrementGuestPassesSeenCount()
  }, [showGuestPassesUpsell])

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) incrementOverageCreditUpsellSeenCount()
  }, [showOverageCreditUpsell, showGuestPassesUpsell])

  // The animated logo needs room for itself and a readable text column next to it.
  const animated = columns >= ANIM_WIDTH + 40
  // Logo width + gap (2) + padding (2)
  const textWidth = Math.max(columns - (animated ? ANIM_WIDTH : SMALL_LOGO_WIDTH) - 4, 20)
  const truncatedVersion = truncate(`${MACRO.FNHARNESS_VERSION} · base ${version}`, Math.max(textWidth - 11, 6))
  const effortSuffix = getEffortSuffix(model, effortValue)
  const { shouldSplit, truncatedModel, truncatedBilling } = formatModelAndBilling(
    getMultimodelProfile()?.provider ?? billingType,
    modelDisplayName + effortSuffix,
    textWidth,
  )
  const cwdAvailableWidth = agentName ? textWidth - 1 - stringWidth(agentName) - 3 : textWidth
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))

  // OffscreenFreeze: the header is the first thing to enter scrollback; a
  // change while it is there would force a full terminal reset.
  return (
    <OffscreenFreeze>
      <Box flexDirection="row" gap={2} alignItems="center">
        <FnLogo animated={animated} />
        <Box flexDirection="column">
          <Text>
            <Text bold>EmberHarness</Text> <Text dimColor>v{truncatedVersion}</Text>
          </Text>
          {shouldSplit ? (
            <>
              <Text dimColor>{truncatedModel}</Text>
              <Text dimColor>{truncatedBilling}</Text>
            </>
          ) : (
            <Text dimColor>
              {truncatedModel} · {truncatedBilling}
            </Text>
          )}
          <Text dimColor>{agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}</Text>
          <Text dimColor>{truncate(formatConnectedLine(connected), textWidth)}</Text>
          {showGuestPassesUpsell && <GuestPassesUpsell />}
          {!showGuestPassesUpsell && showOverageCreditUpsell && <OverageCreditUpsell maxWidth={textWidth} twoLine />}
        </Box>
      </Box>
    </OffscreenFreeze>
  )
}
