/**
 * Turning a grid of lux into the numbers a designer argues about.
 *
 * Uniformity here is the lighting-design convention, **not** the broadcast one:
 * `min:avg` (often written U₀) and `min:max`. Both are ratios in 0..1 where 1 is
 * perfectly even. A stage wash at 0.5 min:avg is respectable; below about 0.3
 * the unevenness is visible to an audience as the performer walks through it.
 */

import type { Blob, Grid, Metrics, Targets } from './types';

export function computeMetrics(grid: Grid, targets: Targets): Metrics {
  const { lux } = grid;
  const n = lux.length;
  if (n === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      median: 0,
      uniformityMinAvg: 0,
      uniformityMinMax: 0,
      coverage: 0,
      darkFraction: 0,
      hotFraction: 0,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let covered = 0;
  let dark = 0;
  let hot = 0;

  const darkThreshold = targets.targetLux * targets.darkFraction;
  const hotThreshold = targets.targetLux * targets.hotMultiple;

  for (let i = 0; i < n; i++) {
    const v = lux[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v >= targets.targetLux) covered++;
    if (v < darkThreshold) dark++;
    if (v > hotThreshold) hot++;
  }

  const avg = sum / n;

  // Sorting a copy rather than the grid itself: the caller still needs the grid
  // in row-major order to draw it.
  const sorted = Float32Array.from(lux).sort();
  const mid = n >> 1;
  const median =
    n % 2 === 0 ? (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) : (sorted[mid] as number);

  return {
    min,
    max,
    avg,
    median,
    uniformityMinAvg: avg > 0 ? min / avg : 0,
    uniformityMinMax: max > 0 ? min / max : 0,
    coverage: covered / n,
    darkFraction: dark / n,
    hotFraction: hot / n,
  };
}

/**
 * Find contiguous regions that are too dark or too bright.
 *
 * A flood fill over 4-connected cells failing the threshold. Regions smaller
 * than `minAreaM2` are dropped — a rig will always have a few isolated cells at
 * the very edge of the stage, and listing each of them as a "dark spot" buries
 * the one that matters under noise.
 */
export function findBlobs(grid: Grid, targets: Targets, minAreaM2 = 0.5): Blob[] {
  const dark = floodFill(
    grid,
    (v) => v < targets.targetLux * targets.darkFraction,
    'dark',
    minAreaM2,
  );
  const hot = floodFill(
    grid,
    (v) => v > targets.targetLux * targets.hotMultiple,
    'hot',
    minAreaM2,
  );

  // Biggest first: that is the order a designer wants to fix them in.
  return [...dark, ...hot].sort((a, b) => b.areaM2 - a.areaM2);
}

function floodFill(
  grid: Grid,
  fails: (lux: number) => boolean,
  kind: 'hot' | 'dark',
  minAreaM2: number,
): Blob[] {
  const { cols, rows, lux, spacing, originX, originY } = grid;
  const seen = new Uint8Array(cols * rows);
  const cellArea = spacing * spacing;
  const blobs: Blob[] = [];
  // An explicit stack rather than recursion: a dark stage is one blob covering
  // every cell, and that overflows the call stack on any real grid size.
  const stack: number[] = [];

  for (let start = 0; start < seen.length; start++) {
    if (seen[start] === 1) continue;
    if (!fails(lux[start] as number)) {
      seen[start] = 1;
      continue;
    }

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    let cellCount = 0;
    let sumX = 0;
    let sumY = 0;
    let peak = kind === 'hot' ? -Infinity : Infinity;

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const col = index % cols;
      const row = (index - col) / cols;

      cellCount++;
      sumX += originX + col * spacing;
      sumY += originY + row * spacing;

      const v = lux[index] as number;
      if (kind === 'hot' ? v > peak : v < peak) peak = v;

      if (col > 0) push(index - 1);
      if (col < cols - 1) push(index + 1);
      if (row > 0) push(index - cols);
      if (row < rows - 1) push(index + cols);
    }

    const areaM2 = cellCount * cellArea;
    if (areaM2 >= minAreaM2) {
      blobs.push({
        kind,
        cellCount,
        areaM2,
        cx: sumX / cellCount,
        cy: sumY / cellCount,
        peakLux: peak,
      });
    }
  }

  return blobs;

  function push(index: number): void {
    if (seen[index] === 1) return;
    if (!fails(lux[index] as number)) {
      seen[index] = 1;
      return;
    }
    seen[index] = 1;
    stack.push(index);
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** 1 footcandle = 1 lumen per square foot = 10.7639 lux. */
export const LUX_PER_FOOTCANDLE = 10.763910416709722;

export const luxToFootcandles = (lux: number): number => lux / LUX_PER_FOOTCANDLE;
export const footcandlesToLux = (fc: number): number => fc * LUX_PER_FOOTCANDLE;

export type Unit = 'lux' | 'fc';

export function formatLevel(lux: number, unit: Unit): string {
  const value = unit === 'fc' ? luxToFootcandles(lux) : lux;
  if (value >= 1000) return Math.round(value).toLocaleString();
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export const unitLabel = (unit: Unit): string => (unit === 'fc' ? 'fc' : 'lux');

/**
 * Reference levels, as a starting point for the target rather than as a rule.
 * Real numbers depend on camera, lens, stock and taste, and the tool should not
 * pretend otherwise — these are offered as presets and are freely editable.
 */
export const LEVEL_PRESETS: ReadonlyArray<{ name: string; lux: number; note: string }> = [
  { name: 'Theatre — general cover', lux: 300, note: 'Comfortable for an audience with no camera.' },
  { name: 'Theatre — key face light', lux: 500, note: 'Front light on faces in a drama house.' },
  { name: 'Corporate / conference', lux: 750, note: 'Presenter lit for a room with screens.' },
  { name: 'Broadcast — general', lux: 1000, note: 'A working level for modern broadcast cameras.' },
  { name: 'Broadcast — high key', lux: 1500, note: 'Deeper stop, more headroom for grading.' },
];
