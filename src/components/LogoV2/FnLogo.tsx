import * as React from 'react';
import { useRef, useState } from 'react';
import { useSettings } from '../../hooks/useSettings.js';
import { Box, Text, useAnimationFrame } from '../../ink.js';
import { CATALOG, dissolve, render, type Frame } from './asciimood/catalog.js';

// FnHarness logo. On a wide terminal it is a looping asciimood animation
// (https://github.com/tmdlz/asciimood) that changes scene every few seconds
// with a dissolve; on a narrow one, the small terminal window with an ƒ prompt
// (same footprint as Clawd, 9 cols × 3 rows).
const SMALL_ROWS = ['▛▀▀▀▀▀▀▀▜', '▌ > ƒ_  ▐', '▙▄▄▄▄▄▄▄▟'];
export const SMALL_LOGO_WIDTH = 9;

export const ANIM_WIDTH = 64;
const ANIM_HEIGHT = 6;
const FRAME_MS = 80;
const SCENE_S = 9;
const FADE_S = 0.7;
// Every drawing that ships with asciimood (the remote ones need its website),
// except the ASCIIMOOD title card, which reads badly at this height.
const PICKS = CATALOG.filter(e => e.remote !== true && e.id !== 'hero');
type Entry = (typeof CATALOG)[number];

// Small drawings (a bolt, a spinning globe) fill a fraction of the strip, so
// they are repeated side by side, up to three times, to span the full width.
const MAX_COPIES = 3;
const copiesCache = new Map<string, number>();
function copiesOf(entry: Entry): number {
  const cached = copiesCache.get(entry.id);
  if (cached !== undefined) return cached;
  let lo = ANIM_WIDTH, hi = -1;
  for (let i = 0; i < 12; i++) {
    const f = render(entry, i / 12 * entry.dur, ANIM_WIDTH, ANIM_HEIGHT);
    for (const line of f.chars) {
      for (let x = 0; x < line.length; x++) {
        if (line[x] !== ' ') {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    }
  }
  const used = hi - lo + 1;
  let copies = 1;
  for (let k = MAX_COPIES; k > 1; k--) {
    if (used <= Math.floor(ANIM_WIDTH / k)) {
      copies = k;
      break;
    }
  }
  copiesCache.set(entry.id, copies);
  return copies;
}

function renderTiled(entry: Entry, t: number): Frame {
  const copies = copiesOf(entry);
  if (copies === 1) return render(entry, t, ANIM_WIDTH, ANIM_HEIGHT);
  const cw = Math.floor(ANIM_WIDTH / copies);
  const tile = render(entry, t, cw, ANIM_HEIGHT);
  const pad = Math.floor((ANIM_WIDTH - cw * copies) / 2);
  const fg = new Uint32Array(ANIM_WIDTH * ANIM_HEIGHT).fill(NO_COLOR);
  const chars = tile.chars.map((line, y) => {
    for (let c = 0; c < copies; c++) {
      for (let x = 0; x < cw; x++) fg[y * ANIM_WIDTH + pad + c * cw + x] = tile.fg[y * cw + x] ?? NO_COLOR;
    }
    return (' '.repeat(pad) + line.repeat(copies)).padEnd(ANIM_WIDTH);
  });
  return { chars, fg };
}

// Neighbouring cells differ by a shade or two; rounding the colour joins them
// into one Text run, so a row is a handful of elements instead of one per cell.
const NO_COLOR = 0x01000000;
function toHex(c: number): string | undefined {
  if (c >= NO_COLOR) return undefined;
  return '#' + (c & 0xf0f0f0).toString(16).padStart(6, '0');
}

type Run = {
  text: string;
  color?: string;
};

function rowsOf(frame: Frame): Run[][] {
  return frame.chars.map((line, y) => {
    const runs: Run[] = [];
    for (let x = 0; x < ANIM_WIDTH; x++) {
      const color = toHex(frame.fg[y * ANIM_WIDTH + x] ?? NO_COLOR);
      const ch = line[x] ?? ' ';
      const last = runs.at(-1);
      // A blank cell shows no colour, so it joins whichever run it follows.
      if (last && (last.color === color || ch === ' ')) last.text += ch;else runs.push({
        text: ch,
        color
      });
    }
    return runs;
  });
}

function AnimatedFnLogo(): React.ReactNode {
  const reducedMotion = useSettings().prefersReducedMotion ?? false;
  const [ref, time] = useAnimationFrame(reducedMotion ? null : FRAME_MS);
  const [start] = useState(() => Math.floor(Math.random() * PICKS.length));
  const origin = useRef<number | null>(null);
  origin.current ??= time;
  const t = (time - origin.current) / 1000;
  const scene = Math.floor(t / SCENE_S);
  const local = t - scene * SCENE_S;
  const entry = PICKS[(start + scene) % PICKS.length]!;
  let frame = renderTiled(entry, local);
  if (scene > 0 && local < FADE_S) {
    const prev = PICKS[(start + scene - 1) % PICKS.length]!;
    frame = dissolve(renderTiled(prev, local + SCENE_S), frame, local / FADE_S, ANIM_WIDTH);
  }
  return <Box ref={ref} flexDirection="column" flexShrink={0} width={ANIM_WIDTH}>
      {rowsOf(frame).map((runs, y) => <Text key={y} wrap="truncate">
          {runs.map((r, i) => <Text key={i} color={r.color}>{r.text}</Text>)}
        </Text>)}
    </Box>;
}

export function FnLogo({
  animated = false
}: {
  animated?: boolean;
}): React.ReactNode {
  if (animated) return <AnimatedFnLogo />;
  return <Box flexDirection="column">
      {SMALL_ROWS.map((row, i) => <Text key={i} color="startupAccent">{row}</Text>)}
    </Box>;
}
