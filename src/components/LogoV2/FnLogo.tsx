import * as React from 'react';
import { useRef, useState } from 'react';
import { useSettings } from '../../hooks/useSettings.js';
import { Box, Text, useAnimationFrame } from '../../ink.js';
import { CATALOG, dissolve, render, type Frame } from './asciimood/catalog.js';

// EmberHarness logo. On a wide terminal it is the asciimood fire animation
// (https://github.com/tmdlz/asciimood), flames rising from a hot bed of embers,
// in its own warm hues; on a narrow one, the small terminal window with an ƒ prompt
// (same footprint as Clawd, 9 cols × 3 rows).
const SMALL_ROWS = ['▛▀▀▀▀▀▀▀▜', '▌ > ƒ_  ▐', '▙▄▄▄▄▄▄▄▟'];
export const SMALL_LOGO_WIDTH = 9;

export const ANIM_WIDTH = 64;
const ANIM_HEIGHT = 6;
const FRAME_MS = 80;
const SCENE_S = 9;
const FADE_S = 0.7;
// Only the fire scene: it is the brand of EmberHarness.
const PICKS = CATALOG.filter(e => e.id === 'fire');
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

// A number in [0, 1) that only depends on its inputs, so a scene keeps the
// same look on every frame but each new scene gets a fresh one.
function seeded(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) h = Math.imul(h ^ (p | 0), 0x01000193) ^ (h >>> 15);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// The drawing and its warm hues are fixed, but speed and phase are not: every
// scene (and every copy within it) plays a little faster or slower and starts
// at a different point of the loop, with the hues nudged by a few degrees.
function variant(entry: Entry, scene: number, copy: number): { entry: Entry; phase: number } {
  const r = (k: number) => seeded(scene, copy, k);
  const shift = (r(1) - 0.5) * 12;
  const [h0, h1] = entry.hues;
  const hues: [number, number] = [h0 + shift, h1 + shift];
  const dur = entry.dur * (0.75 + r(4) * 0.6);
  const { ink: _ink, ground: _ground, ...rest } = entry;
  return { entry: { ...rest, hues, dur }, phase: r(5) * dur };
}

function renderTiled(entry: Entry, t: number, scene: number): Frame {
  const copies = copiesOf(entry);
  const cw = Math.floor(ANIM_WIDTH / copies);
  const pad = Math.floor((ANIM_WIDTH - cw * copies) / 2);
  const fg = new Uint32Array(ANIM_WIDTH * ANIM_HEIGHT).fill(NO_COLOR);
  const rows = Array.from({ length: ANIM_HEIGHT }, () => ' '.repeat(pad));
  for (let c = 0; c < copies; c++) {
    const v = variant(entry, scene, c);
    const tile = render(v.entry, t + v.phase, cw, ANIM_HEIGHT);
    for (let y = 0; y < ANIM_HEIGHT; y++) {
      rows[y] += tile.chars[y] ?? ' '.repeat(cw);
      for (let x = 0; x < cw; x++) fg[y * ANIM_WIDTH + pad + c * cw + x] = tile.fg[y * cw + x] ?? NO_COLOR;
    }
  }
  return { chars: rows.map(row => row.padEnd(ANIM_WIDTH)), fg };
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
  // Different on every launch, so the same scene never repeats its colours.
  const [salt] = useState(() => Math.floor(Math.random() * 1e9));
  const origin = useRef<number | null>(null);
  origin.current ??= time;
  const t = (time - origin.current) / 1000;
  const scene = Math.floor(t / SCENE_S);
  const local = t - scene * SCENE_S;
  const entry = PICKS[(start + scene) % PICKS.length]!;
  let frame = renderTiled(entry, local, salt + scene);
  if (scene > 0 && local < FADE_S) {
    const prev = PICKS[(start + scene - 1) % PICKS.length]!;
    frame = dissolve(renderTiled(prev, local + SCENE_S, salt + scene - 1), frame, local / FADE_S, ANIM_WIDTH);
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
