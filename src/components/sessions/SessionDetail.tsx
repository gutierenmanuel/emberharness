import figures from 'figures';
import React, { useEffect, useState } from 'react';
import { readBgTail, listBgSessions } from '../../cli/bg.js';
import { Box, Text } from '../../ink.js';
import { readTranscriptTail } from '../../utils/sessionDirectory/transcriptTail.js';
import type { ActionId, SessionRow } from '../../utils/sessionDirectory/types.js';
import { ACTION_LABEL } from './runAction.js';

const TAIL_LINES = 12;

type Props = {
  row: SessionRow;
  /** Acciones activas (sin view-log) y el índice resaltado. */
  actions: ActionId[];
  cursor: number;
  /** Texto del mensaje que se está escribiendo, o undefined si no se está componiendo. */
  composing?: string;
  /** Resultado de la última acción (o aviso de su primera confirmación). */
  notice?: { ok: boolean; text: string; manual?: string };
  pendingConfirm?: ActionId;
};

/** Origen legible de la fila para la línea de datos del detalle. */
function describe(row: SessionRow): string {
  const parts: string[] = [row.origin === 'element' ? 'element' : row.origin];
  if (row.room) parts.push(`sala ${row.room.slice(0, 6)}…`);
  parts.push(row.harness);
  if (row.account || row.model) parts.push([row.account, row.model].filter(Boolean).join(':'));
  if (row.pid) parts.push(`pid ${row.pid}`);
  if (row.tmux) parts.push(`tmux ${row.tmux.socket}/${row.tmux.session}`);
  if (row.kitty) parts.push(`kitty ${row.kitty.windowId}`);
  if (row.bgId) parts.push(`bg ${row.bgId}`);
  return parts.join(' · ');
}

/**
 * Detalle de una sesión: datos, últimas líneas de la conversación y menú de acciones.
 * Se abre con → sobre una fila; ← vuelve a la lista.
 */
export function SessionDetail({ row, actions, cursor, composing, notice, pendingConfirm }: Props): React.ReactNode {
  const [tail, setTail] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      let lines: string[] = [];
      if (row.bgId) {
        const meta = listBgSessions().find(m => m.id === row.bgId);
        if (meta) lines = readBgTail(meta, TAIL_LINES);
      }
      if (lines.length === 0) lines = await readTranscriptTail(row, TAIL_LINES);
      if (alive) setTail(lines);
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [row.key, row.bgId, row.sessionId]);

  const disabled = Object.entries(row.disabledActions ?? {}) as Array<[ActionId, string]>;

  return <Box flexDirection="column">
      <Text bold>{row.title}</Text>
      <Text dimColor wrap="truncate-end">{describe(row)}</Text>
      {row.cwd && <Text dimColor wrap="truncate-end">{row.cwd}</Text>}
      <Text dimColor>── últimas líneas ──</Text>
      {tail.length === 0 ? <Text dimColor>(sin transcript legible)</Text> : tail.map((l, i) => <Text key={i} wrap="truncate-end">
            {l}
          </Text>)}
      <Box flexDirection="column" marginTop={1}>
        {actions.map((a, i) => <Text key={a} color={i === cursor ? 'background' : undefined}>
            {i === cursor ? figures.pointer : ' '} {ACTION_LABEL[a]}
            {a === 'send-message' && composing !== undefined ? `: ${composing}▏` : ''}
            {pendingConfirm === a ? '  — Enter otra vez para confirmar' : ''}
          </Text>)}
        {disabled.map(([a, why]) => <Text key={a} dimColor wrap="truncate-end">
            {'  '}{ACTION_LABEL[a]} ({why})
          </Text>)}
        {actions.length === 0 && disabled.length === 0 && <Text dimColor>Sin acciones para esta sesión.</Text>}
      </Box>
      {notice && <Box flexDirection="column" marginTop={1}>
          <Text color={notice.ok ? 'success' : 'warning'} wrap="wrap">{notice.text}</Text>
          {notice.manual && <Text dimColor wrap="wrap">A mano: {notice.manual}</Text>}
        </Box>}
    </Box>;
}
