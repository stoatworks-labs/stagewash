import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bench, describe } from 'vitest';

import { fixtureFrame, vec } from '../geometry';
import { buildCosTable } from '../photometry/distribution';
import { estimatePhotometrics } from '../photometry/estimator';
import { parseIes } from '../photometry/ies';
import { fieldAngleOfPhotometry, maxGammaOf, type PreparedFixture } from '../rig';
import { buildSampleField, solve } from '../solver';
import type { MeasurementPlane, Photometry, Stage } from '../types';

/**
 * Solver benchmarks.
 *
 * `npm run bench`
 *
 * The shapes that matter are not "the default rig" — that is 18 fixtures on a
 * small stage and solves in about a millisecond however badly it is written.
 * They are the ones a real design reaches:
 *
 * - **a festival rig**: 120 fixtures, most of them narrow, over a big stage
 * - **a fine grid**: 0.05 m sampling, which is what you switch to when you are
 *   chasing a dark spot
 * - **imported photometry**: tabulated distributions, which cost a binary
 *   search and an `atan2` per point that the analytic ones do not
 *
 * A narrow fixture over a big stage is the interesting case, because its beam
 * touches a few percent of the grid and everything else is wasted work.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const BIG_STAGE: Stage = { widthM: 20, depthM: 12, heightM: 0 };
const SMALL_STAGE: Stage = { widthM: 10, depthM: 6, heightM: 0 };

const COARSE: MeasurementPlane = { orientation: 'horizontal', heightM: 1.5, resolutionM: 0.2 };
const FINE: MeasurementPlane = { orientation: 'horizontal', heightM: 1.5, resolutionM: 0.05 };

function prepared(
  photometry: Photometry,
  position: { x: number; y: number; z: number },
  aim: { x: number; y: number; z: number },
  id: string,
): PreparedFixture {
  const direction = vec(aim.x - position.x, aim.y - position.y, aim.z - position.z);
  const symmetric =
    photometry.kind === 'analytic'
      ? photometry.k === photometry.kCross
      : photometry.cAngles.length <= 1;

  return {
    id,
    channel: id,
    position: vec(position.x, position.y, position.z),
    frame: fixtureFrame(direction, 0),
    photometry,
    gain: 1,
    maxGamma: maxGammaOf(photometry),
    fieldAngle: fieldAngleOfPhotometry(photometry),
    rotationallySymmetric: symmetric,
    // Mirrors what `prepareRig` does. Without it the benchmark would quietly
    // measure the un-accelerated path and report the wrong thing.
    ...(symmetric && photometry.kind === 'analytic'
      ? { cosTable: buildCosTable(photometry) }
      : {}),
  };
}

const narrow = estimatePhotometrics({
  kind: 'profile',
  beamAngle: 11,
  fieldAngle: 16,
  peakCandela: 395_560,
}).photometry;

const wide = estimatePhotometrics({
  kind: 'wash',
  fieldAngle: 50,
  lumens: 12_000,
  lumensAtLens: true,
}).photometry;

const measured = parseIes(
  readFileSync(join(HERE, '..', '__tests__', 'fixtures', 'etc-s4-36-hpl750-115.ies'), 'latin1'),
).photometrics.photometry;

/** `count` fixtures on a bar, fanned across the stage. */
function rig(photometry: Photometry, count: number, stage: Stage): PreparedFixture[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = -stage.widthM / 2 + t * stage.widthM;
    // Alternate between two bars so the aims are not all identical.
    const upstage = i % 2 === 0;
    return prepared(
      photometry,
      { x: x * 0.8, y: upstage ? 2 : -7, z: 7 },
      { x, y: upstage ? stage.depthM * 0.7 : stage.depthM * 0.3, z: 1.5 },
      `f${i}`,
    );
  });
}

describe('coarse grid, small stage (the default rig’s shape)', () => {
  const field = buildSampleField(SMALL_STAGE, COARSE);
  const analytic = rig(narrow, 18, SMALL_STAGE);
  const tabulated = rig(measured, 18, SMALL_STAGE);

  bench('18 analytic', () => {
    solve(analytic, field);
  });

  bench('18 measured (tabulated)', () => {
    solve(tabulated, field);
  });
});

describe('coarse grid, big stage, festival rig', () => {
  const field = buildSampleField(BIG_STAGE, COARSE);
  const narrowRig = rig(narrow, 120, BIG_STAGE);
  const wideRig = rig(wide, 120, BIG_STAGE);
  const measuredRig = rig(measured, 120, BIG_STAGE);

  bench('120 narrow analytic', () => {
    solve(narrowRig, field);
  });

  bench('120 wide analytic', () => {
    solve(wideRig, field);
  });

  bench('120 measured (tabulated)', () => {
    solve(measuredRig, field);
  });
});

describe('fine grid (0.05 m), big stage', () => {
  const field = buildSampleField(BIG_STAGE, FINE);
  const narrowRig = rig(narrow, 60, BIG_STAGE);
  const measuredRig = rig(measured, 60, BIG_STAGE);

  bench('60 narrow analytic', () => {
    solve(narrowRig, field);
  });

  bench('60 measured (tabulated)', () => {
    solve(measuredRig, field);
  });
});
