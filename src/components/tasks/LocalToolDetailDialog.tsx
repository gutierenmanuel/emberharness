import React from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import type { LocalToolTaskState } from '../../tasks/LocalToolTask/LocalToolTask.js';
import type { DeepImmutable } from '../../types/utils.js';

type Props = {
  task: DeepImmutable<LocalToolTaskState>;
  onKill?: () => void;
  onBack: () => void;
};

// Minimal detail view for a backgrounded generic tool call ('local_tool').
// The progress and the final result live in the task output file, which the
// model reads with TaskOutput and the user can follow with `tail -F`.
export function LocalToolDetailDialog({ task, onKill, onBack }: Props): React.ReactNode {
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
      <Text bold>Background tool</Text>
      <Text>{task.description}</Text>
      <Text dimColor>Tool: {task.toolName}</Text>
      <Text dimColor>Status: {task.status}</Text>
      <Text dimColor>Output: {task.outputFile}</Text>
      <Text dimColor>{task.status === 'running' && onKill ? 'x to stop, ' : ''}Left or Esc to go back</Text>
    </Box>;
}
