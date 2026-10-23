import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { truncate } from '../../utils/format.js';
import type { MonitorOutput } from './MonitorTool.js';

export function renderMonitorToolUseMessage(input: Partial<{
  command: string;
  description: string;
}>): React.ReactNode {
  return truncate(input.description || input.command || '', 80, true);
}
export function renderMonitorResultMessage(output: MonitorOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Monitoring <Text bold>{output.description}</Text>{' '}
        <Text dimColor>
          ({output.persistent ? 'no deadline' : `stops after ${Math.round(output.timeoutMs / 60000)} min`}, task {output.taskId})
        </Text>
      </Text>
    </MessageResponse>;
}
