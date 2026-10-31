import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { INJECTED_ARROW } from '../../constants/figures.js';
import { CROSS_SESSION_MESSAGE_TAG } from '../../constants/xml.js';
import { Box, Text } from '../../ink.js';
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

// <cross-session-message from="uds:..." pid="..." session="..." name="..." cwd="...">body</cross-session-message>
const CROSS_SESSION_RE = new RegExp(`<${CROSS_SESSION_MESSAGE_TAG}([^>]*)>\\n?([\\s\\S]*?)\\n?</${CROSS_SESSION_MESSAGE_TAG}>`);
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}
const MAX_LINES = 12;
export function UserCrossSessionMessage({
  addMargin,
  param
}: Props): React.ReactNode {
  const m = CROSS_SESSION_RE.exec(param.text);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const name = attr(attrs, 'name');
  const pid = attr(attrs, 'pid');
  const cwd = attr(attrs, 'cwd');
  const who = name ? `${name} (pid ${pid ?? '?'})` : pid ? `pid ${pid}` : attr(attrs, 'from') ?? 'unknown';
  const lines = (m[2] ?? '').trim().split('\n');
  const shown = lines.slice(0, MAX_LINES).join('\n');
  const more = lines.length > MAX_LINES ? `\n… ${lines.length - MAX_LINES} more lines` : '';
  return <Box marginTop={addMargin ? 1 : 0} flexDirection="column">
      <Text>
        <Text color="suggestion">{INJECTED_ARROW}</Text> <Text dimColor>
          message from session {who}
          {cwd ? ` · ${cwd}` : ''}
        </Text>
      </Text>
      <Box paddingLeft={2}>
        <Text>
          {shown}
          {more}
        </Text>
      </Box>
    </Box>;
}
