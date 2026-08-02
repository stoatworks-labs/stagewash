/**
 * The illuminance solve.
 *
 * For every sample point on the measurement plane, sum over every fixture:
 *
 *   E = Σ  I(C, γ) · cos ι / d²
 *
 * `I` is the fixture's luminous intensity in the direction of the point, `d` is
 * the distance, and `ι` is the angle between the incoming ray and the surface
 * normal. That is the whole of the physics; everything else in this file exists
 * to make it run fast enough that the heatmap keeps up with a drag.
 *
 * ## What this models, and what it does not
 *
 * Modelled: inverse square, the cosine law, the real intensity distribution,
 * fixture level and gel transmission.
 *
 * **Not** modelled: inter-reflection from the deck, walls or a cyc; atmospheric
 * scatter (haze); shutter cuts, gobos and barn doors; and the shadow a person
 * standing on the stage casts on the person behind them. This is a *direct*
 * illuminance calculation, which is the right model for a stage — a black box
 * with a black floor reflects almost nothing — and the wrong model for a white
 * studio, where inter-reflection can add a third again. `docs/model.md` says so
 * in the same words, and the report footer says it too.
 */

import { DEG, RAD } from './geometry';
import { intensityAt } from './photometry/distribution';
import type { PreparedFixture } from './rig';
import type { Grid, MeasurementPlane, Stage } from './types';

/** Sample positions and the surface normal they are measured against. */
export interface SampleField {
  cols: number;
  rows: number;
  spacing: number;
  originX: number;
  originY: number;
  /** World position of every sample, `3 * cols * rows` long, xyz interleaved. */
  points: Float64Array;
  normal: { x: number; y: number; z: number };
}

/**
 * Lay out the sample grid over the stage.
 *
 * Both plane orientations share the same footprint — the same `x`/`y` positions
 * at the same height — and differ only in the surface normal. That is
 * deliberate: it means you can flip between "light on the floor" and "light on
 * a face" and compare the two maps cell for cell, which is the comparison that
 * tells you whether a rig has front light or just top light.
 */
export function buildSampleField(stage: Stage, plane: MeasurementPlane): SampleField {
  const spacing = Math.max(plane.resolutionM, 0.02);
  const cols = Math.max(Math.round(stage.widthM / spacing) + 1, 2);
  const rows = Math.max(Math.round(stage.depthM / spacing) + 1, 2);

  // Origin at the downstage-left corner of the stage, in the coordinate system
  // documented on `types.ts`: x across, y upstage, z up.
  const originX = -stage.widthM / 2;
  const originY = 0;
  const z = stage.heightM + plane.heightM;

  const points = new Float64Array(cols * rows * 3);
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const y = originY + r * spacing;
    for (let c = 0; c < cols; c++) {
      points[i++] = originX + c * spacing;
      points[i++] = y;
      points[i++] = z;
    }
  }

  // A vertical plane faces the audience, who sit at negative y.
  const normal =
    plane.orientation === 'vertical' ? { x: 0, y: -1, z: 0 } : { x: 0, y: 0, z: 1 };

  return { cols, rows, spacing, originX, originY, points, normal };
}

export interface SolveOutput {
  grid: Grid;
  /** Mean lux each fixture contributed, ordered as the input fixtures. */
  perFixtureAvg: number[];
  elapsedMs: number;
}

/**
 * Accumulate every fixture into the grid.
 *
 * Looping fixture-outer / point-inner rather than the other way round lets the
 * fixture's constants — position, frame, gain, cutoff — stay in registers
 * across the whole inner loop, and makes the per-fixture contribution a free
 * by-product rather than a second pass.
 */
export function solve(
  fixtures: PreparedFixture[],
  field: SampleField,
): SolveOutput {
  const started = performance.now();
  const count = field.cols * field.rows;
  const lux = new Float32Array(count);
  const perFixtureAvg: number[] = new Array(fixtures.length).fill(0);

  const { points, normal } = field;
  const nx = normal.x;
  const ny = normal.y;
  const nz = normal.z;

  for (let f = 0; f < fixtures.length; f++) {
    const fixture = fixtures[f] as PreparedFixture;
    const { position, frame, photometry, gain } = fixture;
    const px = position.x;
    const py = position.y;
    const pz = position.z;
    const fx = frame.forward.x;
    const fy = frame.forward.y;
    const fz = frame.forward.z;
    const rx = frame.right.x;
    const ry = frame.right.y;
    const rz = frame.right.z;
    const ux = frame.up.x;
    const uy = frame.up.y;
    const uz = frame.up.z;

    // One comparison against this replaces an acos and a table lookup for every
    // point outside the beam, which on a typical rig is most of them.
    const cosCutoff = Math.cos(Math.min(fixture.maxGamma, 180) * DEG);
    const symmetric = fixture.rotationallySymmetric;

    let fixtureSum = 0;

    for (let i = 0, p = 0; i < count; i++, p += 3) {
      const dx = (points[p] as number) - px;
      const dy = (points[p + 1] as number) - py;
      const dz = (points[p + 2] as number) - pz;

      const d2 = dx * dx + dy * dy + dz * dz;
      // A fixture sitting exactly on a sample point would divide by zero and
      // paint one infinite cell, which then swamps every statistic on the page.
      if (d2 < 1e-6) continue;

      const d = Math.sqrt(d2);
      const inv = 1 / d;

      // cos of the angle between the incoming ray and the surface normal.
      // Negative means the light is arriving from behind the surface — a
      // backlight cannot put anything on the front of a face.
      const cosIncidence = -(dx * nx + dy * ny + dz * nz) * inv;
      if (cosIncidence <= 0) continue;

      const cosGamma = (dx * fx + dy * fy + dz * fz) * inv;
      if (cosGamma <= cosCutoff) continue;

      const gamma = Math.acos(cosGamma > 1 ? 1 : cosGamma) * RAD;

      let c = 0;
      if (!symmetric) {
        const alongRight = dx * rx + dy * ry + dz * rz;
        const alongUp = dx * ux + dy * uy + dz * uz;
        c = Math.atan2(alongUp, alongRight) * RAD;
        if (c < 0) c += 360;
      }

      const contribution = (intensityAt(photometry, c, gamma) * cosIncidence * gain) / d2;
      lux[i] = (lux[i] as number) + contribution;
      fixtureSum += contribution;
    }

    perFixtureAvg[f] = fixtureSum / count;
  }

  return {
    grid: {
      cols: field.cols,
      rows: field.rows,
      originX: field.originX,
      originY: field.originY,
      spacing: field.spacing,
      lux,
    },
    perFixtureAvg,
    elapsedMs: performance.now() - started,
  };
}

/**
 * Illuminance at a single arbitrary point, for the inspector's "what does this
 * fixture put here" readout and for the tests.
 *
 * Deliberately the same arithmetic as the inner loop above rather than a
 * shared helper the loop calls: the loop cannot afford the call and the object
 * allocation, and duplicating eight lines is a smaller risk than the two
 * drifting apart silently. `solver.test.ts` pins them against each other.
 */
export function illuminanceAtPoint(
  fixture: PreparedFixture,
  point: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
): number {
  const dx = point.x - fixture.position.x;
  const dy = point.y - fixture.position.y;
  const dz = point.z - fixture.position.z;

  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 1e-6) return 0;

  const d = Math.sqrt(d2);
  const inv = 1 / d;

  const cosIncidence = -(dx * normal.x + dy * normal.y + dz * normal.z) * inv;
  if (cosIncidence <= 0) return 0;

  const { forward, right, up } = fixture.frame;
  const cosGamma = (dx * forward.x + dy * forward.y + dz * forward.z) * inv;
  const gamma = Math.acos(Math.min(Math.max(cosGamma, -1), 1)) * RAD;
  if (gamma > fixture.maxGamma) return 0;

  let c = 0;
  if (!fixture.rotationallySymmetric) {
    c = Math.atan2(dx * up.x + dy * up.y + dz * up.z, dx * right.x + dy * right.y + dz * right.z) * RAD;
    if (c < 0) c += 360;
  }

  return (intensityAt(fixture.photometry, c, gamma) * cosIncidence * fixture.gain) / d2;
}
