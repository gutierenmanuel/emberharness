import React from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js';
import type { DeepImmutable } from '../../types/utils.js';

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>;
  onKill?: () => void;
  onBack: () => void;
};

// Minimal detail view for the (not yet produced) 'monitor_mcp' task type.
export function MonitorMcpDetailDialog({ task, onKill, onBack }: Props): React.ReactNode {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'left' || e.key === 'escape') {
      e.preventDefault();
      onBack();
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault();
      onKill();
    }
  };
  return <Box flexDirection="column" paddingX={1} tabIndex={0} autoFocus={true} onKeyDown={onKeyDown}>
      <Text bold>Monitor details</Text>
      <Text>{task.description}</Text>
      <Text dimColor>{task.status === 'running' && onKill ? 'x to stop, ' : ''}Left or Esc to go back</Text>
    </Box>;
}
