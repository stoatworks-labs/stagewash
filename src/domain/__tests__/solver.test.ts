import { describe, expect, it } from 'vitest';

import { fixtureFrame, vec } from '../geometry';
import { computeMetrics, findBlobs, footcandlesToLux, luxToFootcandles } from '../metrics';
import { estimatePhotometrics } from '../photometry/estimator';
import type { PreparedFixture } from '../rig';
import { buildSampleField, illuminanceAtPoint, solve } from '../solver';
import type { MeasurementPlane, Stage, Targets } from '../types';

const STAGE: Stage = { widthM: 10, depthM: 6, heightM: 0 };

const HORIZONTAL: MeasurementPlane = {
  orientation: 'horizontal',
  heightM: 0,
  resolutionM: 0.5,
};

const TARGETS: Targets = {
  targetLux: 500,
  darkFraction: 0.5,
  hotMultiple: 2,
  minUniformity: 0.4,
};

/** A fixture with a known, exactly-controllable peak intensity. */
function makeFixture(options: {
  position: { x: number; y: number; z: number };
  aimAt: { x: number; y: number; z: number };
  peakCandela: number;
  fieldAngle?: number;
  gain?: number;
  roll?: number;
  fieldAngleCross?: number;
}): PreparedFixture {
  const { position, aimAt, peakCandela, fieldAngle = 60, gain = 1, roll = 0 } = options;

  const photometrics = estimatePhotometrics({
    kind: 'profile',
    fieldAngle,
    ...(options.fieldAngleCross !== undefined
      ? { fieldAngleCross: options.fieldAngleCross }
      : {}),
    peakCandela,
  });

  const direction = vec(aimAt.x - position.x, aimAt.y - position.y, aimAt.z - position.z);

  return {
    id: 'f1',
    channel: '1',
    position: vec(position.x, position.y, position.z),
    frame: fixtureFrame(direction, roll),
    photometry: photometrics.photometry,
    gain,
    maxGamma: photometrics.photometry.kind === 'analytic'
      ? photometrics.photometry.cutoffGamma
      : 180,
    rotationallySymmetric: options.fieldAngleCross === undefined,
  };
}

describe('the physics, against closed-form answers', () => {
  it('gives I / d² directly under a downlight', () => {
    const fixture = makeFixture({
      position: { x: 0, y: 3, z: 8 },
      aimAt: { x: 0, y: 3, z: 0 },
      peakCandela: 64_000,
    });

    // 8 m below a 64,000 cd centre beam: 64000 / 64 = 1000 lux.
    const lux = illuminanceAtPoint(fixture, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(lux).toBeCloseTo(1000, 6);
  });

  it('follows the inverse square as the fixture goes up', () => {
    const near = makeFixture({
      position: { x: 0, y: 3, z: 4 },
      aimAt: { x: 0, y: 3, z: 0 },
      peakCandela: 64_000,
    });
    const far = makeFixture({
      position: { x: 0, y: 3, z: 8 },
      aimAt: { x: 0, y: 3, z: 0 },
      peakCandela: 64_000,
    });

    const atNear = illuminanceAtPoint(near, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 1 });
    const atFar = illuminanceAtPoint(far, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(atNear).toBeCloseTo(atFar * 4, 6);
  });

  it('applies the cosine law off-axis', () => {
    // Fixture 5 m up, sample 5 m to the side: the ray arrives at 45° to the
    // deck, over a slant distance of 5√2.
    const fixture = makeFixture({
      position: { x: 0, y: 0, z: 5 },
      aimAt: { x: 5, y: 0, z: 0 },
      peakCandela: 100_000,
      fieldAngle: 120,
    });

    const point = { x: 5, y: 0, z: 0 };
    const lux = illuminanceAtPoint(fixture, point, { x: 0, y: 0, z: 1 });

    // On axis, so the full peak applies: E = I·cos45 / (5√2)².
    const expected = (100_000 * Math.cos(Math.PI / 4)) / 50;
    expect(lux).toBeCloseTo(expected, 6);
  });

  it('scales linearly with level and gel transmission', () => {
    const full = makeFixture({
      position: { x: 0, y: 0, z: 8 },
      aimAt: { x: 0, y: 0, z: 0 },
      peakCandela: 64_000,
    });
    const dimmed = makeFixture({
      position: { x: 0, y: 0, z: 8 },
      aimAt: { x: 0, y: 0, z: 0 },
      peakCandela: 64_000,
      gain: 0.25,
    });

    const a = illuminanceAtPoint(full, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const b = illuminanceAtPoint(dimmed, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(b).toBeCloseTo(a * 0.25, 6);
  });

  it('puts nothing on a surface the light arrives behind', () => {
    // A fixture behind the performer cannot light the front of their face.
    const backlight = makeFixture({
      position: { x: 0, y: 6, z: 6 },
      aimAt: { x: 0, y: 2, z: 1.5 },
      peakCandela: 100_000,
    });

    const faceNormal = { x: 0, y: -1, z: 0 };
    expect(illuminanceAtPoint(backlight, { x: 0, y: 2, z: 1.5 }, faceNormal)).toBe(0);
  });
});

describe('front light versus top light on a face', () => {
  const target = { x: 0, y: 3, z: 1.5 };
  const faceNormal = { x: 0, y: -1, z: 0 };
  const deckNormal = { x: 0, y: 0, z: 1 };

  it('shows a downlight lighting the floor but barely the face', () => {
    const overhead = makeFixture({
      position: { x: 0, y: 3, z: 8 },
      aimAt: { x: 0, y: 3, z: 0 },
      peakCandela: 100_000,
    });

    const onDeck = illuminanceAtPoint(overhead, { x: 0, y: 3, z: 0 }, deckNormal);
    const onFace = illuminanceAtPoint(overhead, target, faceNormal);

    expect(onDeck).toBeGreaterThan(1000);
    expect(onFace).toBe(0); // straight down: the ray is parallel to the face
  });

  it('shows an FOH fixture doing the opposite', () => {
    // Downstage of the stage edge and above it: a normal front-of-house angle.
    const foh = makeFixture({
      position: { x: 0, y: -8, z: 7 },
      aimAt: target,
      peakCandela: 100_000,
    });

    const onFace = illuminanceAtPoint(foh, target, faceNormal);
    expect(onFace).toBeGreaterThan(400);
  });
});

describe('solve', () => {
  it('agrees exactly with the single-point calculation at every cell', () => {
    // This is the test that keeps the solver's hand-inlined inner loop and
    // illuminanceAtPoint from drifting apart. They are deliberately duplicated
    // for speed, so something has to pin them together.
    const fixtures = [
      makeFixture({
        position: { x: -2, y: -4, z: 6 },
        aimAt: { x: 0, y: 2, z: 0 },
        peakCandela: 80_000,
        fieldAngle: 40,
      }),
      makeFixture({
        position: { x: 3, y: -3, z: 7 },
        aimAt: { x: 1, y: 3, z: 0 },
        peakCandela: 60_000,
        fieldAngle: 30,
      }),
    ];

    const field = buildSampleField(STAGE, HORIZONTAL);
    const { grid } = solve(fixtures, field);

    for (let i = 0; i < grid.lux.length; i++) {
      const point = {
        x: field.points[i * 3] as number,
        y: field.points[i * 3 + 1] as number,
        z: field.points[i * 3 + 2] as number,
      };
      const expected = fixtures.reduce(
        (sum, f) => sum + illuminanceAtPoint(f, point, field.normal),
        0,
      );
      // Relative, not absolute: the grid is a Float32Array, so a 1,200 lux cell
      // carries about 1e-4 lux of storage error. An absolute tolerance passes
      // at the dark edges and fails under the hot spots, which reads like a
      // solver bug and is only the float width.
      const actual = grid.lux[i] as number;
      const scale = Math.max(Math.abs(expected), 1);
      expect(Math.abs(actual - expected) / scale).toBeLessThan(1e-6);
    }
  });

  it('adds fixtures together', () => {
    const one = makeFixture({
      position: { x: 0, y: 3, z: 8 },
      aimAt: { x: 0, y: 3, z: 0 },
      peakCandela: 64_000,
    });
    const field = buildSampleField(STAGE, HORIZONTAL);

    const single = solve([one], field);
    const doubled = solve([one, one], field);

    for (let i = 0; i < single.grid.lux.length; i++) {
      expect(doubled.grid.lux[i] as number).toBeCloseTo((single.grid.lux[i] as number) * 2, 3);
    }
  });

  it('reports each fixture’s own contribution to the average', () => {
    const bright = makeFixture({
      position: { x: -2, y: 3, z: 8 },
      aimAt: { x: -2, y: 3, z: 0 },
      peakCandela: 100_000,
    });
    const dim = makeFixture({
      position: { x: 2, y: 3, z: 8 },
      aimAt: { x: 2, y: 3, z: 0 },
      peakCandela: 10_000,
    });

    const field = buildSampleField(STAGE, HORIZONTAL);
    const { perFixtureAvg, grid } = solve([bright, dim], field);

    expect(perFixtureAvg[0] as number).toBeGreaterThan(perFixtureAvg[1] as number);

    // The parts must add up to the whole.
    const total = (perFixtureAvg[0] as number) + (perFixtureAvg[1] as number);
    const { avg } = computeMetrics(grid, TARGETS);
    expect(total).toBeCloseTo(avg, 3);
  });

  it('lays the grid out over the stage with the right footprint', () => {
    const field = buildSampleField(STAGE, HORIZONTAL);

    expect(field.cols).toBe(21); // 10 m at 0.5 m
    expect(field.rows).toBe(13); // 6 m at 0.5 m
    expect(field.originX).toBe(-5);
    expect(field.originY).toBe(0);
    expect(field.points[0]).toBe(-5);
    expect(field.points[1]).toBe(0);
  });

  it('uses the same footprint for a vertical plane, only a different normal', () => {
    const vertical = buildSampleField(STAGE, { ...HORIZONTAL, orientation: 'vertical', heightM: 1.5 });
    const horizontal = buildSampleField(STAGE, { ...HORIZONTAL, heightM: 1.5 });

    expect(vertical.cols).toBe(horizontal.cols);
    expect(vertical.rows).toBe(horizontal.rows);
    expect(vertical.points).toEqual(horizontal.points);
    expect(vertical.normal).toEqual({ x: 0, y: -1, z: 0 });
    expect(horizontal.normal).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('does not produce an infinite cell when a fixture sits on the plane', () => {
    const onTheDeck = makeFixture({
      position: { x: 0, y: 0, z: 0 },
      aimAt: { x: 0, y: 3, z: 0 },
      peakCandela: 100_000,
    });

    const field = buildSampleField(STAGE, HORIZONTAL);
    const { grid } = solve([onTheDeck], field);

    for (const v of grid.lux) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('metrics', () => {
  it('computes uniformity, coverage and the extremes', () => {
    const grid = {
      cols: 2,
      rows: 2,
      originX: 0,
      originY: 0,
      spacing: 1,
      lux: Float32Array.from([100, 300, 500, 700]),
    };

    const m = computeMetrics(grid, TARGETS);
    expect(m.min).toBe(100);
    expect(m.max).toBe(700);
    expect(m.avg).toBe(400);
    expect(m.median).toBe(400);
    expect(m.uniformityMinAvg).toBeCloseTo(0.25, 6);
    expect(m.uniformityMinMax).toBeCloseTo(100 / 700, 6);
    // Target 500: two of four cells reach it.
    expect(m.coverage).toBe(0.5);
    // Dark threshold is 250: one cell is under.
    expect(m.darkFraction).toBe(0.25);
    // Hot threshold is 1000: none.
    expect(m.hotFraction).toBe(0);
  });

  it('reports perfect uniformity for a flat field', () => {
    const grid = {
      cols: 3,
      rows: 3,
      originX: 0,
      originY: 0,
      spacing: 1,
      lux: Float32Array.from(new Array(9).fill(500)),
    };

    const m = computeMetrics(grid, TARGETS);
    expect(m.uniformityMinAvg).toBeCloseTo(1, 6);
    expect(m.uniformityMinMax).toBeCloseTo(1, 6);
    expect(m.coverage).toBe(1);
  });
});

describe('findBlobs', () => {
  it('finds a dark hole and locates its centre', () => {
    // 5×5 of 600 lux with a 3×3 hole of 100 in the middle.
    const cols = 5;
    const rows = 5;
    const lux = Float32Array.from(new Array(cols * rows).fill(600));
    for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) lux[r * cols + c] = 100;

    const grid = { cols, rows, originX: 0, originY: 0, spacing: 1, lux };
    const blobs = findBlobs(grid, TARGETS, 0.5);

    const dark = blobs.filter((b) => b.kind === 'dark');
    expect(dark).toHaveLength(1);
    expect(dark[0]?.cellCount).toBe(9);
    expect(dark[0]?.areaM2).toBe(9);
    expect(dark[0]?.cx).toBeCloseTo(2, 6);
    expect(dark[0]?.cy).toBeCloseTo(2, 6);
    expect(dark[0]?.peakLux).toBe(100);
  });

  it('finds a hot spot', () => {
    const cols = 5;
    const rows = 5;
    const lux = Float32Array.from(new Array(cols * rows).fill(600));
    lux[12] = 5000;
    for (const i of [7, 11, 13, 17]) lux[i] = 3000;

    const grid = { cols, rows, originX: 0, originY: 0, spacing: 1, lux };
    const hot = findBlobs(grid, TARGETS, 0.5).filter((b) => b.kind === 'hot');

    expect(hot).toHaveLength(1);
    expect(hot[0]?.cellCount).toBe(5);
    expect(hot[0]?.peakLux).toBe(5000);
  });

  it('drops specks below the minimum area so the real one stands out', () => {
    const cols = 10;
    const rows = 10;
    const lux = Float32Array.from(new Array(cols * rows).fill(600));
    lux[0] = 10; // a single isolated cell at the corner
    for (let r = 4; r <= 7; r++) for (let c = 4; c <= 7; c++) lux[r * cols + c] = 10;

    const grid = { cols, rows, originX: 0, originY: 0, spacing: 0.5, lux };
    const dark = findBlobs(grid, TARGETS, 0.5).filter((b) => b.kind === 'dark');

    // The speck is 0.25 m², under the 0.5 m² floor; the 4×4 block is 4 m².
    expect(dark).toHaveLength(1);
    expect(dark[0]?.areaM2).toBe(4);
  });

  it('handles a stage that is entirely dark without blowing the stack', () => {
    const cols = 120;
    const rows = 80;
    const grid = {
      cols,
      rows,
      originX: 0,
      originY: 0,
      spacing: 0.1,
      lux: new Float32Array(cols * rows),
    };

    const dark = findBlobs(grid, TARGETS).filter((b) => b.kind === 'dark');
    expect(dark).toHaveLength(1);
    expect(dark[0]?.cellCount).toBe(cols * rows);
  });
});

describe('unit conversion', () => {
  it('round-trips lux and footcandles', () => {
    expect(luxToFootcandles(1076.391)).toBeCloseTo(100, 4);
    expect(footcandlesToLux(100)).toBeCloseTo(1076.391, 3);
    expect(luxToFootcandles(footcandlesToLux(53.7))).toBeCloseTo(53.7, 9);
  });
});
