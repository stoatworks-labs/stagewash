import { describe, expect, it } from 'vitest';

import { FIXTURE_LIBRARY } from '../../data/fixtures';
import { defaultProject } from '../../state/defaultProject';
import { computeMetrics, findBlobs } from '../metrics';
import { modelIndex, prepareRig } from '../rig';
import { buildSampleField, solve } from '../solver';
import type { Grid, Project } from '../types';

function run(project: Project): { grid: Grid; field: ReturnType<typeof buildSampleField> } {
  const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
  const { fixtures } = prepareRig(project, models);
  const field = buildSampleField(project.stage, project.plane);
  const { grid } = solve(fixtures, field);
  return { grid, field };
}

/** World position of the brightest cell. */
function peakAt(grid: Grid): { x: number; y: number; lux: number } {
  let best = -1;
  let index = 0;
  for (let i = 0; i < grid.lux.length; i++) {
    if ((grid.lux[i] as number) > best) {
      best = grid.lux[i] as number;
      index = i;
    }
  }
  const col = index % grid.cols;
  const row = (index - col) / grid.cols;
  return {
    x: grid.originX + col * grid.spacing,
    y: grid.originY + row * grid.spacing,
    lux: best,
  };
}

/** Mean lux of the row nearest a given y. */
function meanAtY(grid: Grid, y: number): number {
  const row = Math.round((y - grid.originY) / grid.spacing);
  const clamped = Math.max(0, Math.min(grid.rows - 1, row));
  let sum = 0;
  for (let c = 0; c < grid.cols; c++) sum += grid.lux[clamped * grid.cols + c] as number;
  return sum / grid.cols;
}

describe('the grid is laid out the way the renderer assumes', () => {
  /**
   * The check that catches a flipped heatmap.
   *
   * A mirrored texture is almost impossible to spot by eye on a symmetric rig —
   * and a lighting rig is usually near-symmetric left to right — so the only
   * reliable test is an asymmetric one whose answer is known from the geometry
   * alone. Here: one fixture, aimed at a known point, and the peak has to be
   * at that point.
   */
  /**
   * A downlight directly above an asymmetric point. Straight down means the
   * peak is exactly under the fixture with no oblique-incidence shift to argue
   * about, and the point is off centre in both axes so a flip in either would
   * move it.
   */
  function downlightAt(x: number, y: number): Project {
    const base = defaultProject();
    const first = base.fixtures[0];
    if (!first) throw new Error('default rig has no fixtures');

    return {
      ...base,
      structures: [
        { id: 'rig', name: 'test', kind: 'truss', from: { x, y, z: 8 }, to: { x, y, z: 8 } },
      ],
      fixtures: [
        {
          ...first,
          id: 'probe',
          structureId: 'rig',
          along: 0,
          position: { x, y, z: 8 },
          aim: { x, y, z: 0 },
          level: 1,
          transmission: 1,
        },
      ],
    };
  }

  /**
   * The peak can only ever land on a sample, so the tolerance is one grid
   * spacing — not an arbitrary number of decimal places. A target that falls
   * between samples (4.5 m on a 0.2 m grid does) reports the nearer one.
   */
  function expectPeakNear(grid: Grid, x: number, y: number): void {
    const peak = peakAt(grid);
    expect(Math.abs(peak.x - x)).toBeLessThanOrEqual(grid.spacing);
    expect(Math.abs(peak.y - y)).toBeLessThanOrEqual(grid.spacing);
  }

  it('puts a downlight’s peak directly under it', () => {
    expectPeakNear(run(downlightAt(3, 1)).grid, 3, 1);
  });

  it('would fail if either axis were mirrored', () => {
    // -3, 4.5 is the mirror of 3, 1.5 in both axes on a 10 x 6 stage, so a
    // flip in x, in y, or in both would move the peak to a place this test
    // rejects.
    expectPeakNear(run(downlightAt(-3, 4.5)).grid, -3, 4.5);
  });

  it('tracks the aim point when it moves upstage', () => {
    const base = defaultProject();
    const make = (y: number): Grid =>
      run({
        ...base,
        fixtures: base.fixtures
          .filter((f) => f.id === 'foh-1')
          .map((f) => ({ ...f, aim: { x: 0, y, z: 1.5 } })),
      }).grid;

    expect(peakAt(make(1)).y).toBeLessThan(peakAt(make(4)).y);
  });

  it('puts row 0 at the downstage edge', () => {
    const base = defaultProject();
    const { grid, field } = run(base);

    expect(field.originY).toBe(0);
    expect(grid.originY).toBe(0);
    // First row of samples is the downstage edge of the stage.
    expect(field.points[1]).toBe(0);
    // Last row is the upstage edge.
    const lastRowStart = (grid.rows - 1) * grid.cols * 3;
    expect(field.points[lastRowStart + 1]).toBeCloseTo(base.stage.depthM, 6);
  });
});

describe('the default rig', () => {
  const project = defaultProject();
  const { grid } = run(project);
  const metrics = computeMetrics(grid, project.targets);

  it('is a working wash, not a broken one', () => {
    // The default is the first thing anyone sees, and it has to look like a
    // rig that someone focused rather than one that missed. An earlier version
    // returned min:avg 0.01 because the beams did not overlap, which reads as
    // "this tool is wrong" rather than "this rig needs work".
    expect(metrics.coverage).toBeGreaterThan(0.85);
    expect(metrics.min).toBeGreaterThan(100);
    expect(metrics.uniformityMinAvg).toBeGreaterThan(0.1);
    expect(findBlobs(grid, project.targets).filter((b) => b.kind === 'dark')).toHaveLength(0);
  });

  it('is still imperfect enough to be worth improving', () => {
    // If the default were perfectly even there would be nothing to demonstrate.
    expect(metrics.uniformityMinAvg).toBeLessThan(0.6);
  });

  it('lights both depth zones, not just one', () => {
    // The two zones are aimed at y = 1.8 (FOH) and y = 4.4 (LX1). Both must
    // actually carry light, or the rig is a band across the middle.
    const downstage = meanAtY(grid, 1.8);
    const upstage = meanAtY(grid, 4.4);

    expect(downstage).toBeGreaterThan(project.targets.targetLux);
    expect(upstage).toBeGreaterThan(project.targets.targetLux);

    // The upstage zone comes out several times brighter, and that is correct
    // rather than a fault in the rig:
    //
    //   LX1  — 90,885 cd at 5.1 m, arriving 28° off vertical
    //          => 90885 x cos28 / 5.1^2  ~ 3,100 lux
    //   FOH  — 105,690 cd at 10.1 m, arriving 60° off vertical
    //          => 105690 x cos60 / 10.1^2 ~   510 lux
    //
    // Six times, from inverse square and the cosine law alone. Front light
    // always reads weak on a horizontal plane because it arrives nearly
    // edge-on to it — which is the whole reason the vertical/face plane is in
    // this app, and why balancing a rig on a floor map alone misleads you.
    //
    // So the bound here is loose on purpose. Tightening it would mean fudging
    // the default rig's levels to flatter a floor reading, which is exactly
    // the mistake the tool is meant to expose.
    const ratio = Math.max(downstage, upstage) / Math.min(downstage, upstage);
    expect(ratio).toBeLessThan(6);
  });

  it('solves fast enough to keep up with a drag', () => {
    const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
    const { fixtures } = prepareRig(project, models);
    const field = buildSampleField(project.stage, project.plane);

    const started = performance.now();
    for (let i = 0; i < 10; i++) solve(fixtures, field);
    const perSolve = (performance.now() - started) / 10;

    // 14 fixtures over a 51x31 grid. The real budget is one animation frame;
    // 50 ms leaves room for a slow CI box without letting a genuine
    // regression through.
    expect(perSolve).toBeLessThan(50);
  });
});

describe('front light versus top light, on the default rig', () => {
  it('reads much lower on the vertical plane than the horizontal one', () => {
    // The headline diagnostic this app exists to provide. The same rig
    // measured on a face rather than on the floor must come out dimmer,
    // because most of the light arrives from above and contributes little to a
    // vertical surface.
    const base = defaultProject();

    const horizontal = computeMetrics(
      run({ ...base, plane: { ...base.plane, orientation: 'horizontal', heightM: 1.5 } }).grid,
      base.targets,
    );
    const vertical = computeMetrics(
      run({ ...base, plane: { ...base.plane, orientation: 'vertical', heightM: 1.5 } }).grid,
      base.targets,
    );

    expect(vertical.avg).toBeLessThan(horizontal.avg);
    // And it must not be zero — this rig does have front light.
    expect(vertical.avg).toBeGreaterThan(50);
  });
});
