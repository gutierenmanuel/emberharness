import figures from 'figures';
import React, { useEffect, useState } from 'react';
import { listBgSessions, readBgTail, statusOf, stopBgSession } from '../../cli/bg.js';
import { type BgMeta, type BgStatus, formatStart, shortPrompt } from '../../cli/bgCore.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';

type Props = {
  onDone: () => void;
};

type Row = {
  meta: BgMeta;
  status: BgStatus;
};

const REFRESH_MS = 1500;
const TAIL_LINES = 12;

function loadRows(): Row[] {
  return listBgSessions().map(meta => ({
    meta,
    status: statusOf(meta)
  }));
}

function statusColor(status: BgStatus): 'success' | 'error' | 'warning' | undefined {
  if (status === 'running') return 'success';
  if (status === 'failed' || status === 'lost') return 'error';
  if (status === 'stopped') return 'warning';
  return undefined;
}

/**
 * Agents view: every background session (`/background`, `fnharness --bg`) with
 * its live status. Enter opens the tail of its log, x stops a running one.
 * Opened with ← on an empty prompt.
 */
export function BgSessionsDialog({
  onDone
}: Props): React.ReactNode {
  useRegisterOverlay('bg-sessions-dialog');
  const [rows, setRows] = useState<Row[]>(loadRows);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timer = setInterval(() => setRows(loadRows()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const selectedIndex = Math.max(0, rows.findIndex(r => r.meta.id === selectedId));
  const selected = rows[selectedIndex];
  const detail = detailId ? rows.find(r => r.meta.id === detailId) : undefined;
  const runningCount = rows.filter(r => r.status === 'running').length;

  const move = (delta: number) => {
    if (rows.length === 0) return;
    const next = (selectedIndex + delta + rows.length) % rows.length;
    setSelectedId(rows[next]!.meta.id);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (detail) {
      if (e.key === 'left' || e.key === 'escape') {
        e.preventDefault();
        setDetailId(undefined);
      }
      return;
    }
    if (e.key === 'left') {
      e.preventDefault();
      onDone();
    } else if (e.key === 'up') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'down') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'return' && selected) {
      e.preventDefault();
      setDetailId(selected.meta.id);
    } else if (e.key === 'x' && selected?.status === 'running') {
      e.preventDefault();
      void stopBgSession(selected.meta).then(() => setRows(loadRows()));
    }
  };

  const guide = detail ? <Byline>
      <KeyboardShortcutHint shortcut="←/Esc" action="back" />
    </Byline> : <Byline>
      <KeyboardShortcutHint shortcut="↑/↓" action="select" />
      <KeyboardShortcutHint shortcut="Enter" action="view log" />
      {selected?.status === 'running' && <KeyboardShortcutHint shortcut="x" action="stop" />}
      <KeyboardShortcutHint shortcut="←/Esc" action="close" />
    </Byline>;

  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title={detail ? `Session ${detail.meta.id}` : 'Background sessions'} subtitle={<Text>
            {runningCount} running · {rows.length} total
          </Text>} onCancel={detail ? () => setDetailId(undefined) : onDone} color="background" inputGuide={() => guide}>
        {detail ? <Box flexDirection="column">
            <Text dimColor>
              {detail.meta.account} · {detail.status} · {detail.meta.cwd}
            </Text>
            <Text>{shortPrompt(detail.meta.prompt, 200)}</Text>
            <Box flexDirection="column" marginTop={1}>
              {readBgTail(detail.meta, TAIL_LINES).map((line, i) => <Text key={i} wrap="truncate-end">
                  {line}
                </Text>)}
            </Box>
          </Box> : rows.length === 0 ? <Text dimColor>
            No background sessions. Start one with /background &lt;prompt&gt;.
          </Text> : <Box flexDirection="column">
            {rows.map(r => <Text key={r.meta.id} color={r.meta.id === selected?.meta.id ? 'background' : undefined} wrap="truncate-end">
                {r.meta.id === selected?.meta.id ? figures.pointer : ' '} {r.meta.id}{' '}
                <Text color={statusColor(r.status)}>{r.status.padEnd(7)}</Text>{' '}
                <Text dimColor>
                  {formatStart(r.meta.startedAt)} {r.meta.account}
                </Text>{' '}
                {shortPrompt(r.meta.prompt, 60)}
              </Text>)}
          </Box>}
      </Dialog>
    </Box>;
}
