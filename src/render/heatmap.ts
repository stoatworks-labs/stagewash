/**
 * The heatmap colour ramp and its texture.
 *
 * ## Why this ramp
 *
 * The default is **viridis**, sampled at 16 stops. It is perceptually uniform —
 * equal steps in lux look like equal steps in colour — and it survives being
 * printed in greyscale and being looked at by the ~8% of men with a red/green
 * colour deficiency. The traditional rainbow ramp fails both: it has a bright
 * band at yellow that reads as a feature in the data when it is an artefact of
 * the palette, and it collapses to mush in greyscale.
 *
 * A `banded` mode is offered alongside it, because for judging *evenness* a
 * stepped scale is genuinely easier to read than a smooth one — you can see the
 * contour move as you nudge a fixture. That is the same reason ArrayCalc draws
 * bands.
 */

import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';

import type { Grid } from '../domain/types';

export type Ramp = 'viridis' | 'banded' | 'grey';

/** Viridis control points, RGB 0..255. */
const VIRIDIS: ReadonlyArray<readonly [number, number, number]> = [
  [68, 1, 84],
  [72, 26, 108],
  [71, 47, 125],
  [65, 68, 135],
  [57, 86, 140],
  [49, 104, 142],
  [42, 120, 142],
  [35, 136, 142],
  [31, 152, 139],
  [34, 168, 132],
  [53, 183, 121],
  [84, 197, 104],
  [122, 209, 81],
  [165, 219, 54],
  [210, 226, 27],
  [253, 231, 37],
];

function sampleRamp(t: number): [number, number, number] {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * (VIRIDIS.length - 1);
  const i = Math.min(Math.floor(scaled), VIRIDIS.length - 2);
  const f = scaled - i;
  const a = VIRIDIS[i] as readonly [number, number, number];
  const b = VIRIDIS[i + 1] as readonly [number, number, number];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Colour for a normalised level, as CSS — used by the legend and the report. */
export function rampColour(t: number, ramp: Ramp = 'viridis'): string {
  const [r, g, b] = colourFor(t, ramp);
  return `rgb(${r}, ${g}, ${b})`;
}

function colourFor(t: number, ramp: Ramp): [number, number, number] {
  if (ramp === 'grey') {
    const v = Math.round(Math.max(0, Math.min(1, t)) * 255);
    return [v, v, v];
  }
  if (ramp === 'banded') {
    // Eight bands. Quantising *before* sampling the ramp keeps the band edges
    // exactly where the legend says they are.
    const bands = 8;
    const step = Math.floor(Math.max(0, Math.min(0.999, t)) * bands) / (bands - 1);
    return sampleRamp(step);
  }
  return sampleRamp(t);
}

export interface HeatmapScale {
  /** Lux mapped to the bottom of the ramp. Always 0. */
  min: number;
  /** Lux mapped to the top of the ramp. */
  max: number;
}

/**
 * Choose the top of the colour scale.
 *
 * Autoscaling to the maximum is the obvious choice and the wrong one: a single
 * hot cell under a fixture aimed at the deck compresses the entire acting area
 * into the bottom two stops, and the map goes flat exactly when it should be
 * most informative. So the default is the **98th percentile**, which ignores
 * that spike, and the UI offers a manual override for comparing two rigs on the
 * same scale.
 */
export function chooseScale(grid: Grid, override: number | null): HeatmapScale {
  if (override !== null && override > 0) return { min: 0, max: override };

  const n = grid.lux.length;
  if (n === 0) return { min: 0, max: 1 };

  const sorted = Float32Array.from(grid.lux).sort();
  const p98 = sorted[Math.min(n - 1, Math.floor(n * 0.98))] as number;
  return { min: 0, max: p98 > 0 ? p98 : 1 };
}

/**
 * Build an RGBA texture of the grid.
 *
 * `LinearFilter` on both axes: the grid is a sampling of a continuous field, so
 * smoothing between samples is a truer picture than showing the sample cells as
 * squares. (The stepped look is available deliberately, via the `banded` ramp,
 * rather than accidentally, via the filter.)
 */
export function buildHeatmapTexture(
  grid: Grid,
  scale: HeatmapScale,
  ramp: Ramp = 'viridis',
): DataTexture {
  const { cols, rows, lux } = grid;
  const data = new Uint8Array(cols * rows * 4);
  const span = scale.max - scale.min;
  const inv = span > 1e-9 ? 1 / span : 0;

  for (let i = 0; i < cols * rows; i++) {
    const t = ((lux[i] as number) - scale.min) * inv;
    const [r, g, b] = colourFor(t, ramp);
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }

  const texture = new DataTexture(data, cols, rows, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Legend stops for the UI, from the bottom of the scale to the top. */
export function legendStops(
  scale: HeatmapScale,
  ramp: Ramp,
  count = 6,
): Array<{ lux: number; colour: string }> {
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return { lux: scale.min + (scale.max - scale.min) * t, colour: rampColour(t, ramp) };
  });
}
