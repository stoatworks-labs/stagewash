import { describe, expect, it } from 'vitest';

import { DEG } from '../geometry';
import { buildCosTable, intensityAt, sampleCosTable } from '../photometry/distribution';
import { CUTOFF_FRACTION, estimatePhotometrics } from '../photometry/estimator';
import type { AnalyticPhotometry } from '../types';

/**
 * The cosine-space table is the one place this app trades exactness for speed,
 * so the size of that trade is measured here rather than asserted.
 *
 * There are two separate things to keep apart:
 *
 * 1. **Interpolation error inside the beam** — the real approximation, and it
 *    is tiny.
 * 2. **The step at the cutoff** — the analytic beam is truncated to zero at
 *    `cutoffGamma`, where it still has `CUTOFF_FRACTION` of peak. A table
 *    smooths that discontinuity across one cell, so it differs from the exact
 *    function there by up to the size of the step. That is not interpolation
 *    error, it is a discontinuity that only exists because of the cutoff — and
 *    smoothing it is arguably the better behaviour.
 */

const beam = (fieldAngle: number, beamAngle?: number): AnalyticPhotometry =>
  estimatePhotometrics({
    kind: 'profile',
    fieldAngle,
    ...(beamAngle !== undefined ? { beamAngle } : {}),
    peakCandela: 100_000,
  }).photometry as AnalyticPhotometry;

/**
 * Worst error against the exact function, as a fraction of peak, over gamma
 * from 0 to `limitFraction` of the cutoff angle.
 *
 * Relative to peak rather than to the local value: an absolute error of 1 cd
 * matters not at all at the axis of a 100,000 cd beam, and calling it a 50%
 * error of a 2 cd tail value would be meaningless.
 */
function worstError(p: AnalyticPhotometry, limitFraction: number): number {
  const table = buildCosTable(p);
  const limit = p.cutoffGamma * limitFraction;
  let worst = 0;

  // Deliberately not aligned with the table's own sample points.
  const steps = 20_000;
  for (let i = 0; i <= steps; i++) {
    const gamma = (limit * i) / steps;
    const exact = intensityAt(p, 0, gamma);
    const approx = sampleCosTable(table, Math.cos(gamma * DEG));
    const error = Math.abs(approx - exact) / p.peakCandela;
    if (error > worst) worst = error;
  }
  return worst;
}

describe('the cosine-space intensity table', () => {
  it.each([
    ['a very narrow beam', 8],
    ['a typical profile', 26],
    ['a wide wash', 50],
    ['a very wide flood', 90],
  ])('reproduces %s inside the beam to better than 1e-5 of peak', (_label, fieldAngle) => {
    // 99% of the way to the cutoff — everything except the truncation step.
    expect(worstError(beam(fieldAngle), 0.99)).toBeLessThan(1e-5);
  });

  it('is exact on the beam axis, where the level actually matters', () => {
    const p = beam(26);
    const table = buildCosTable(p);
    expect(sampleCosTable(table, 1)).toBeCloseTo(p.peakCandela, 1);
  });

  it('stays accurate for a flat-topped beam, which is the hardest shape', () => {
    // A Source Four's 0.75 beam:field ratio fits a super-Gaussian of order ~5,
    // which has a sharp shoulder — the part an interpolation table finds
    // hardest.
    const p = beam(34, 27);
    expect(p.n).toBeGreaterThan(4);
    expect(worstError(p, 0.99)).toBeLessThan(1e-5);
  });

  it('is accurate across the whole range of beam widths', () => {
    for (const fieldAngle of [8, 16, 26, 36, 50, 70, 90]) {
      expect(worstError(beam(fieldAngle), 0.99)).toBeLessThan(1e-5);
    }
  });

  it('smooths the cutoff step, and by no more than the step itself', () => {
    // The only place the table and the exact function differ appreciably. The
    // beam is truncated at CUTOFF_FRACTION of peak, so the step is that big,
    // and the table spreads it over one cell instead of dropping it in one
    // sample. Bounded by the step: the table never invents light.
    const p = beam(26);
    expect(worstError(p, 1.0)).toBeLessThanOrEqual(CUTOFF_FRACTION);

    // And in absolute terms this is 100 cd on a 100,000 cd fixture — 1 lux at
    // 10 m, against a manufacturer's own datasheet and IES file disagreeing by
    // 15% for the same fixture.
    expect(CUTOFF_FRACTION * p.peakCandela).toBeLessThanOrEqual(100);
  });

  it('returns zero past the cutoff', () => {
    const p = beam(26);
    const table = buildCosTable(p);
    expect(sampleCosTable(table, Math.cos((p.cutoffGamma + 5) * DEG))).toBe(0);
  });
});
