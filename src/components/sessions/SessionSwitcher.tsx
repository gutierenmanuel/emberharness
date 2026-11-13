import figures from 'figures';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { loadSessionRows } from '../../utils/sessionDirectory/sources.js';
import { layoutSessionRow } from '../../utils/sessionDirectory/rowLayout.js';
import { buildEntries, summaryLine, type DirectoryEntry } from '../../utils/sessionDirectory/rows.js';
import type { ActionId, RowStatus, SessionRow } from '../../utils/sessionDirectory/types.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { SessionDetail } from './SessionDetail.js';
import { replacesThisSession, runAction } from './runAction.js';

type Props = {
  onDone: () => void;
};

const REFRESH_MS = 1500;
const VISIBLE = 14;

type Notice = { ok: boolean; text: string; manual?: string };

function statusColor(status: RowStatus): 'success' | 'error' | 'warning' | undefined {
  if (status === 'busy') return 'success';
  if (status === 'waiting') return 'warning';
  if (status === 'failed' || status === 'lost') return 'error';
  return undefined;
}

/** Ventana de `size` entradas que contiene el índice `focus`. */
function windowOf(total: number, focus: number, size: number): [number, number] {
  if (total <= size) return [0, total];
  const start = Math.min(Math.max(0, focus - Math.floor(size / 2)), total - size);
  return [start, start + size];
}

/** Acciones activas del detalle: todas menos "ver log" (el detalle ya muestra la cola). */
function detailActions(row: SessionRow): ActionId[] {
  return row.actions.filter(a => a !== 'view-log');
}

/**
 * Selector de sesiones de toda la máquina, abierto con ← con el prompt vacío o con
 * ctrl+x ctrl+w. Agrupa por estado, filtra por palabras (escribe directamente), y
 * salta a la sesión elegida con su acción por defecto; → abre el detalle con todas
 * sus acciones. El filtro lo gestiona este componente (no un Select) para que las
 * letras nunca se las coma un atajo.
 */
export function SessionSwitcher({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('session-switcher');
  const { columns } = useTerminalSize();
  const [rows, setRows] = useState<SessionRow[] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [detailKey, setDetailKey] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [composing, setComposing] = useState<string | undefined>(undefined);
  const [pendingConfirm, setPendingConfirm] = useState<ActionId | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const busyRef = useRef(false);

  const refresh = useCallback(() => {
    void loadSessionRows().then(setRows, () => setRows(prev => prev ?? []));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const all = rows ?? [];
  const entries = useMemo<DirectoryEntry[]>(() => buildEntries(all, query), [all, query]);
  const selectable = entries.filter((e): e is Extract<DirectoryEntry, { type: 'row' }> => e.type === 'row');
  const selectedRow = selectable.find(e => e.row.key === selectedKey)?.row ?? selectable[0]?.row;
  const detailRow = detailKey ? all.find(r => r.key === detailKey) : undefined;
  const actions = detailRow ? detailActions(detailRow) : [];
  const now = Date.now();

  const move = (delta: number) => {
    if (selectable.length === 0) return;
    const i = Math.max(0, selectable.findIndex(e => e.row.key === selectedRow?.key));
    setSelectedKey(selectable[(i + delta + selectable.length) % selectable.length]!.row.key);
  };

  const exec = async (row: SessionRow, action: ActionId, text?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const out = await runAction(row, action, { rows: all, text });
      setNotice(out.message || out.manualCommand ? { ok: out.ok, text: out.message, manual: out.manualCommand } : undefined);
      if (out.close) onDone();
      else refresh();
    } finally {
      busyRef.current = false;
      setPendingConfirm(undefined);
      setComposing(undefined);
    }
  };

  const openDetail = (row: SessionRow, preselect?: ActionId) => {
    setDetailKey(row.key);
    setNotice(undefined);
    setPendingConfirm(undefined);
    setComposing(undefined);
    setCursor(Math.max(0, detailActions(row).indexOf(preselect ?? 'none' as ActionId)));
  };

  const handleListKey = (e: KeyboardEvent) => {
    if (e.ctrl && e.key === 'c') {
      onDone();
    } else if (e.key === 'left') {
      e.preventDefault();
      onDone();
    } else if (e.key === 'escape') {
      e.preventDefault();
      if (query) setQuery('');
      else onDone();
    } else if (e.key === 'up') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'down') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'right' && selectedRow) {
      e.preventDefault();
      openDetail(selectedRow);
    } else if (e.key === 'return' && selectedRow) {
      e.preventDefault();
      setNotice(undefined);
      const first = selectedRow.actions[0];
      if (selectedRow.self) onDone();
      else if (!first || first === 'view-log' || replacesThisSession(first)) openDetail(selectedRow, first);
      else void exec(selectedRow, first);
    } else if (e.key === 'backspace' || e.key === 'delete') {
      e.preventDefault();
      setQuery(q => q.slice(0, -1));
    } else if (e.key.length === 1 && !e.ctrl && !e.meta) {
      e.preventDefault();
      setQuery(q => q + e.key);
    }
  };

  const handleDetailKey = (e: KeyboardEvent) => {
    if (!detailRow) return;
    if (composing !== undefined) {
      e.preventDefault();
      if (e.key === 'escape') setComposing(undefined);
      else if (e.key === 'return') void exec(detailRow, 'send-message', composing);
      else if (e.key === 'backspace' || e.key === 'delete') setComposing(c => (c ?? '').slice(0, -1));
      else if (e.key.length === 1 && !e.ctrl && !e.meta) setComposing(c => (c ?? '') + e.key);
      return;
    }
    if (e.key === 'left' || e.key === 'escape') {
      e.preventDefault();
      setDetailKey(undefined);
      setNotice(undefined);
      setPendingConfirm(undefined);
    } else if (e.key === 'up' && actions.length > 0) {
      e.preventDefault();
      setCursor(c => (c - 1 + actions.length) % actions.length);
      setPendingConfirm(undefined);
    } else if (e.key === 'down' && actions.length > 0) {
      e.preventDefault();
      setCursor(c => (c + 1) % actions.length);
      setPendingConfirm(undefined);
    } else if (e.key === 'return') {
      e.preventDefault();
      const action = actions[Math.min(cursor, actions.length - 1)];
      if (!action) return;
      if (action === 'send-message') setComposing('');
      else if (replacesThisSession(action) && pendingConfirm !== action) setPendingConfirm(action);
      else void exec(detailRow, action);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => (detailRow ? handleDetailKey(e) : handleListKey(e));

  // Entradas visibles (cabeceras incluidas) alrededor de la fila seleccionada.
  const focusIdx = Math.max(0, entries.findIndex(en => en.type === 'row' && en.row.key === selectedRow?.key));
  const [from, to] = windowOf(entries.length, focusIdx, VISIBLE);

  const listGuide = <Byline>
      <KeyboardShortcutHint shortcut="↑/↓" action="elegir" />
      <KeyboardShortcutHint shortcut="Enter" action="saltar" />
      <KeyboardShortcutHint shortcut="→" action="acciones" />
      <KeyboardShortcutHint shortcut="Esc" action={query ? 'borrar filtro' : 'cerrar'} />
      <KeyboardShortcutHint shortcut="←" action="cerrar" />
    </Byline>;
  const detailGuide = <Byline>
      <KeyboardShortcutHint shortcut="↑/↓" action="elegir" />
      <KeyboardShortcutHint shortcut="Enter" action="ejecutar" />
      <KeyboardShortcutHint shortcut="←/Esc" action="volver" />
    </Byline>;

  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title="Sesiones" subtitle={<Text>{rows ? summaryLine(all) : 'buscando sesiones…'}</Text>} onCancel={detailRow ? () => setDetailKey(undefined) : onDone} isCancelActive={false} color="background" inputGuide={() => detailRow ? detailGuide : listGuide}>
        {detailRow ? <SessionDetail row={detailRow} actions={actions} cursor={cursor} composing={composing} notice={notice} pendingConfirm={pendingConfirm} /> : <Box flexDirection="column">
            <Text>
              <Text dimColor>Filtro: </Text>
              {query || <Text dimColor>(escribe para buscar por título, directorio, cuenta o agente)</Text>}
            </Text>
            {rows !== undefined && entries.length === 0 && <Text dimColor>{query ? 'Ninguna sesión coincide.' : 'No hay sesiones.'}</Text>}
            {entries.slice(from, to).map(en => en.type === 'header' ? <Text key={`h-${en.label}`} dimColor bold>
                  ── {en.label} ──
                </Text> : <SessionLine key={en.row.key} row={en.row} selected={en.row.key === selectedRow?.key} columns={columns - 6} now={now} />)}
            {entries.length > VISIBLE && <Text dimColor>{from > 0 ? '↑ ' : '  '}{to < entries.length ? '↓ más' : ''}</Text>}
            {notice && <Text color={notice.ok ? 'success' : 'warning'} wrap="wrap">{notice.text}</Text>}
            <Text dimColor>◐ esperando · ● trabajando · ○ en espera · ✓ terminada</Text>
          </Box>}
      </Dialog>
    </Box>;
}

function SessionLine({ row, selected, columns, now }: { row: SessionRow; selected: boolean; columns: number; now: number }): React.ReactNode {
  const p = layoutSessionRow(row, columns, now);
  return <Text color={selected ? 'background' : undefined} wrap="truncate-end">
      {selected ? figures.pointer : ' '} <Text color={statusColor(row.status)}>{p.glyph}</Text> <Text dimColor={!selected}>{p.origin}</Text> {p.title} <Text dimColor>{p.cwd} {p.who} {p.age}</Text>
    </Text>;
}
