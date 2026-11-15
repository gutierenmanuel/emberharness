import * as React from 'react';
import { useCallback } from 'react';
import { Box, Text } from '../ink.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import type { AppState } from '../state/AppState.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { isLocalToolTask } from '../tasks/LocalToolTask/LocalToolTask.js';
import { env } from '../utils/env.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';

type Props = {
  toolUseID: string;
};

/**
 * "(ctrl+b to run in background)" under a generic tool call that has been
 * running long enough to register as a foreground local_tool task. Only the
 * hint lives here: the key itself is handled once, at session level, by
 * SessionBackgroundHint (hasForegroundTasks → backgroundAll), so several
 * concurrent tool calls do not each bind ctrl+b.
 */
export function LocalToolBackgroundHint({
  toolUseID
}: Props): React.ReactNode {
  const selector = useCallback((s: AppState) => Object.values(s.tasks).some(t => isLocalToolTask(t) && t.toolUseId === toolUseID && !t.isBackgrounded && t.status === 'running'), [toolUseID]);
  const isForeground = useAppStateMaybeOutsideOfProvider(selector);
  const baseShortcut = useShortcutDisplay('task:background', 'Task', 'ctrl+b');
  const shortcut = env.terminal === 'tmux' && baseShortcut === 'ctrl+b' ? 'ctrl+b ctrl+b (twice)' : baseShortcut;
  if (!isForeground) {
    return null;
  }
  return <Box paddingLeft={5}>
      <Text dimColor={true}>
        <KeyboardShortcutHint shortcut={shortcut} action="run in background" parens={true} />
      </Text>
    </Box>;
}
