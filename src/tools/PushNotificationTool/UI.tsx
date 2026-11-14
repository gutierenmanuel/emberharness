import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { PushNotificationOutput } from './PushNotificationTool.js'

// Ink only renders bare strings inside <Text>; returning the string straight
// from the tool crashed the TUI ("Text string ... must be rendered inside <Text>").
export function renderToolResultMessage(output: PushNotificationOutput): React.ReactNode {
  return (
    <MessageResponse>
      <Text dimColor>{output.message}</Text>
    </MessageResponse>
  )
}
