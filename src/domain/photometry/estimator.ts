/**
 * Synthesising a plausible distribution for a fixture nobody has measured.
 *
 * ## The shape
 *
 * Real stage-lighting optics produce a beam that is very close to Gaussian in
 * the centre and falls off faster at the edge as the optic's aperture cuts in.
 * We fit a **super-Gaussian**
 *
 *   I(γ) = I₀ · exp(−k · γⁿ)
 *
 * through the two numbers every fixture datasheet publishes: the beam angle
 * (50% of peak) and the field angle (10% of peak). Two constraints, two
 * unknowns, closed form:
 *
 *   0.5 = exp(−k · θ_b ⁿ)      ln2  = k · θ_b ⁿ
 *   0.1 = exp(−k · θ_f ⁿ)      ln10 = k · θ_f ⁿ
 *
 *   n = ln(ln10 / ln2) / ln(θ_f / θ_b)
 *   k = ln2 / θ_b ⁿ
 *
 * where θ are **half** angles. The fit is worth trusting because it is not free
 * to be silly: for the beam/field ratios real fixtures actually have (roughly
 * 1.6 to 2.1) it lands on n ≈ 1.8–2.2, i.e. it independently reproduces the
 * Gaussian that physical optics predicts. If a user enters angles that push n
 * far from 2, that is a signal their numbers are wrong, and `fitBeamShape`
 * reports it.
 *
 * ## The scale
 *
 * The shape says nothing about absolute brightness. Two ways to pin it down,
 * in descending order of trustworthiness:
 *
 * 1. **Peak candela** — if the datasheet gives centre-beam candela (or lux at a
 *    stated distance, which is the same thing), use it directly. Nothing is
 *    assumed. This is `normaliseToPeak`.
 * 2. **Lumens** — integrate the shape over the sphere and scale so the total
 *    matches. For an LED fixture the published figure is already the output at
 *    the lens. For a tungsten fixture the published figure is the **bare lamp**,
 *    and you must multiply by an optical efficiency that this module can only
 *    guess at. That guess is the weakest link in the entire application and it
 *    is why `OPTICAL_EFFICIENCY` below is documented as a range and why anything
 *    built this way is stamped `estimated`.
 */

import { DEG } from '../geometry';
import type { AnalyticPhotometry, FixtureKind, FixturePhotometrics } from '../types';
import { beamAngleOf, fieldAngleOf, fluxWithin, integrateFlux } from './distribution';

/**
 * Fraction of bare-lamp flux that leaves the lens.
 *
 * **Calibrated against published ETC photometric datasheets**, not guessed —
 * see `src/data/fixtures.ts` for the figures and `calibration.test.ts` for the
 * check. Each datasheet quotes an "efficiency" that is field lumens ÷ initial
 * bare-lamp lumens, which is exactly this quantity:
 *
 * | fixture                  | measured |
 * |--------------------------|----------|
 * | Source Four 36°          | 65.0%    |
 * | Source Four Zoom 15–30°  | 52–56%   |
 * | Source Four jr 26°       | 47.2%    |
 * | Source Four PAR MCM      | 46–49%   |
 * | Source Four PARNel       | 42–48%   |
 *
 * The first version of this table guessed 28% for a profile, on the reasoning
 * that the gate and shutters throw most of the lamp away. That is wrong by
 * better than a factor of two — a modern dichroic reflector and a well-centred
 * filament recover far more than the intuition suggests — and it would have put
 * every estimated profile less than half as bright as it really is.
 *
 * The LED kinds are 1.0 **by definition**: manufacturers publish LED output
 * measured at the lens, so there is no lamp-to-lens loss left to apply.
 *
 * Values without a measured source are marked, and are the reason an estimated
 * fixture is stamped `estimated`. If a real photometric file exists, import it
 * and none of this is used.
 */
export const OPTICAL_EFFICIENCY: Record<FixtureKind, number> = {
  profile: 0.55, // measured 47–65% across the Source Four range
  fresnel: 0.45, // nearest measured analogue is the PARNel at 42–48%
  pc: 0.5, // no measured source
  par: 0.48, // measured 46–49% on the Source Four PAR MCM
  wash: 1.0, // LED: published lumens are already at the lens
  cyc: 0.5, // no measured source
  batten: 1.0, // LED
  movingSpot: 1.0, // published as fixture output
  movingWash: 1.0,
  beam: 1.0,
};

/**
 * Typical beam:field ratio, used to fill in a missing beam angle.
 *
 * Also calibrated from the datasheets above. Profiles come out around 0.75,
 * which is much flatter-topped than the 0.55 first assumed here — a modern
 * ellipsoidal is deliberately optimised for an even field, and the two-point
 * fit turns that ratio into a super-Gaussian of order ~5 rather than the order
 * ~2 of a soft-edged fixture. That is the shape being right for the right
 * reason: a Source Four really does have a flat field and a fast edge.
 */
export const TYPICAL_BEAM_FIELD_RATIO: Record<FixtureKind, number> = {
  profile: 0.75, // measured 0.68–0.80 across the Source Four range
  fresnel: 0.56, // PARNel measured 0.50 spot, 0.62 flood
  pc: 0.6, // no measured source
  par: 0.56, // measured 0.50–0.61 on the Source Four PAR MCM
  wash: 0.65, // no measured source
  cyc: 0.7, // no measured source
  batten: 0.65, // no measured source
  movingSpot: 0.6, // no measured source
  movingWash: 0.65, // no measured source
  beam: 0.7, // no measured source
};

export interface BeamShape {
  n: number;
  k: number;
  /** True when the fitted exponent is far enough from ~2 to be suspicious. */
  suspicious: boolean;
}

/**
 * Fit the super-Gaussian exponent and decay constant from full beam and field
 * angles in degrees.
 *
 * Falls back to a plain Gaussian (n = 2) when the two angles are too close to
 * separate — `ln(θf/θb)` goes to zero there and n explodes.
 */
export function fitBeamShape(beamAngle: number, fieldAngle: number): BeamShape {
  const thetaB = beamAngle / 2;
  const thetaF = fieldAngle / 2;

  if (!(thetaB > 0) || !(thetaF > thetaB * 1.02)) {
    const k = thetaB > 0 ? Math.LN2 / (thetaB * thetaB) : Math.LN2;
    return { n: 2, k, suspicious: true };
  }

  const n = Math.log(Math.LN10 / Math.LN2) / Math.log(thetaF / thetaB);
  const k = Math.LN2 / Math.pow(thetaB, n);
  return { n, k, suspicious: n < 1.2 || n > 4 };
}

export interface EstimateInput {
  kind: FixtureKind;
  /** Full field angle, degrees (10% of peak). Required. */
  fieldAngle: number;
  /** Full beam angle, degrees (50% of peak). Defaults from the fixture kind. */
  beamAngle?: number;
  /**
   * Cross-axis angles for an asymmetric fixture — a cyc unit or a batten. When
   * given, `fieldAngle`/`beamAngle` describe the C = 0 axis and these describe
   * C = 90.
   */
  fieldAngleCross?: number;
  beamAngleCross?: number;

  /** Scale by flux. Bare-lamp lumens unless `lumensAtLens`. */
  lumens?: number;
  /** True when `lumens` is already measured at the lens (all LED fixtures). */
  lumensAtLens?: boolean;
  /**
   * What `lumens` counts.
   *
   * - `field` — flux **inside the field angle**, which is what a tungsten
   *   fixture's datasheet means by "lumens" and what its quoted "efficiency"
   *   is a fraction of.
   * - `total` — flux over the whole sphere, which is what an integrating
   *   sphere measures and what LED manufacturers publish.
   *
   * Defaults to `total` when `lumensAtLens` is set and `field` otherwise,
   * because those are the two cases: an LED fixture quotes sphere totals, a
   * lamp-based one quotes field lumens. Set it explicitly only when a source
   * departs from that.
   *
   * The difference is about 10%, consistently, and getting it wrong biases
   * every estimated fixture the same way. `calibration.test.ts` pins it.
   */
  lumensBasis?: 'field' | 'total';
  /**
   * Scale by peak intensity instead. Wins over `lumens` when both are given,
   * because it assumes nothing.
   */
  peakCandela?: number;
  /**
   * Alternative to `peakCandela`: illuminance at a stated distance on the beam
   * axis, which is how most datasheets present it. Converted by E · d².
   */
  luxAtDistance?: { lux: number; distanceM: number };
}

/**
 * Build an analytic distribution from what a datasheet actually tells you.
 *
 * The returned photometrics always carry `provenance: 'estimated'` unless the
 * caller overrides it — which it should only do when the scale came from a
 * published centre-beam candela figure, since then only the *shape* is modelled.
 */
export function estimatePhotometrics(input: EstimateInput): FixturePhotometrics {
  const fieldAngle = Math.max(input.fieldAngle, 0.5);
  const beamAngle =
    input.beamAngle ?? fieldAngle * (TYPICAL_BEAM_FIELD_RATIO[input.kind] ?? 0.6);

  const main = fitBeamShape(beamAngle, fieldAngle);

  const fieldCross = input.fieldAngleCross ?? fieldAngle;
  const beamCross =
    input.beamAngleCross ??
    (input.fieldAngleCross !== undefined
      ? fieldCross * (TYPICAL_BEAM_FIELD_RATIO[input.kind] ?? 0.6)
      : beamAngle);
  const cross = fitBeamShape(beamCross, fieldCross);

  // One exponent has to serve both axes; average them so a mildly elliptical
  // beam is not forced to the sharper axis's edge roll-off.
  const n = (main.n + cross.n) / 2;
  const k = Math.LN2 / Math.pow(beamAngle / 2, n);
  const kCross = Math.LN2 / Math.pow(beamCross / 2, n);

  // Cut the beam off where it has fallen to 1% of peak. Real optics have a
  // hard aperture and a super-Gaussian tail is already negligible by then;
  // the cutoff exists so the solver can reject most fixtures for most points
  // with one comparison.
  const cutoffGamma = Math.min(
    2 * Math.pow(Math.log(100) / Math.min(k, kCross), 1 / n),
    180,
  );

  const unit: AnalyticPhotometry = {
    kind: 'analytic',
    peakCandela: 1,
    n,
    k,
    kCross,
    cutoffGamma,
  };

  const peak = resolvePeak(input, unit);
  const photometry: AnalyticPhotometry = { ...unit, peakCandela: peak };

  return {
    photometry,
    outputLumens: integrateFlux(photometry),
    beamAngle: beamAngleOf(photometry),
    fieldAngle: fieldAngleOf(photometry),
    peakCandela: peak,
    provenance: 'estimated',
    source: describeEstimate(input),
  };
}

/** Peak candela for a unit-peak shape, from whichever scale input is available. */
function resolvePeak(input: EstimateInput, unit: AnalyticPhotometry): number {
  if (input.peakCandela !== undefined && input.peakCandela > 0) {
    return input.peakCandela;
  }
  if (input.luxAtDistance && input.luxAtDistance.distanceM > 0) {
    // E = I / d²  ⇒  I = E · d². Inverse square, on axis, normal incidence.
    return input.luxAtDistance.lux * input.luxAtDistance.distanceM ** 2;
  }
  if (input.lumens !== undefined && input.lumens > 0) {
    const efficiency = input.lumensAtLens ? 1 : (OPTICAL_EFFICIENCY[input.kind] ?? 0.5);
    const wanted = input.lumens * efficiency;

    // `wanted` is field lumens unless told otherwise, so it has to be compared
    // against the flux the unit shape puts inside its own field angle — not
    // against its total. Skipping this step made every estimate 10% low.
    const basis = input.lumensBasis ?? (input.lumensAtLens ? 'total' : 'field');
    const unitFlux =
      basis === 'field'
        ? fluxWithin(unit, fieldAngleOf(unit) / 2)
        : integrateFlux(unit);

    return unitFlux > 1e-9 ? wanted / unitFlux : 0;
  }
  return 0;
}

function describeEstimate(input: EstimateInput): string {
  if (input.peakCandela !== undefined) {
    return `Shape fitted to ${input.fieldAngle}° field; scaled to a stated ${Math.round(input.peakCandela).toLocaleString()} cd centre beam.`;
  }
  if (input.luxAtDistance) {
    return `Shape fitted to ${input.fieldAngle}° field; scaled to a stated ${input.luxAtDistance.lux} lux at ${input.luxAtDistance.distanceM} m.`;
  }
  if (input.lumens !== undefined) {
    const eff = input.lumensAtLens ? 1 : (OPTICAL_EFFICIENCY[input.kind] ?? 0.5);
    const basis = input.lumensAtLens ? 'output' : 'bare-lamp';
    return `Estimated from ${input.lumens.toLocaleString()} lm ${basis} and a ${input.fieldAngle}° field, assuming ${Math.round(eff * 100)}% optical efficiency.`;
  }
  return `Shape only — no output figure given, so absolute levels are unusable.`;
}

/**
 * Peak candela implied by a published "lux at distance" photometric row.
 * Exported because the library data files quote datasheets in exactly this
 * form and it is worth doing the conversion in one place.
 */
export const candelaFromLuxAtDistance = (lux: number, distanceM: number): number =>
  lux * distanceM * distanceM;

/**
 * Illuminance on a surface at `distanceM` whose normal is `incidenceDeg` off
 * the beam. The cosine law, exported so the UI can show the same arithmetic the
 * solver does rather than reimplementing it.
 */
export const illuminance = (
  candela: number,
  distanceM: number,
  incidenceDeg = 0,
): number =>
  distanceM <= 1e-6 ? 0 : (candela * Math.cos(incidenceDeg * DEG)) / (distanceM * distanceM);
