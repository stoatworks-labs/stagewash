/**
 * Sampling and characterising luminous intensity distributions.
 *
 * A `Photometry` is plain data (so it can cross a worker boundary); everything
 * that interprets it lives here as a pure function.
 */

import { DEG, RAD, clamp } from '../geometry';
import type { AnalyticPhotometry, Photometry, TabulatedPhotometry } from '../types';

/**
 * Candela in the direction (c, gamma), both in degrees.
 *
 * Out-of-range gamma returns 0 rather than clamping to the edge sample: a
 * tabulated file that stops at 90° stops there because the fixture emits nothing
 * above it, and clamping would smear the last ring of candela over the whole
 * upper hemisphere — which shows up as a stage lit from below by a downlight.
 */
export function intensityAt(p: Photometry, c: number, gamma: number): number {
  return p.kind === 'analytic'
    ? analyticIntensity(p, c, gamma)
    : tabulatedIntensity(p, c, gamma);
}

function analyticIntensity(p: AnalyticPhotometry, c: number, gamma: number): number {
  if (gamma >= p.cutoffGamma) return 0;

  // Fold the two axes of an elliptical beam into one decay constant for this
  // azimuth. For a round beam k === kCross and this is just k.
  const ca = Math.cos(c * DEG);
  const sa = Math.sin(c * DEG);
  const k = p.k * ca * ca + p.kCross * sa * sa;

  return p.peakCandela * Math.exp(-k * Math.pow(gamma, p.n));
}

function tabulatedIntensity(p: TabulatedPhotometry, c: number, gamma: number): number {
  const { gammaAngles, cAngles, candela } = p;
  const nG = gammaAngles.length;
  const nC = cAngles.length;
  if (nG === 0 || nC === 0) return 0;

  const gLo = gammaAngles[0] as number;
  const gHi = gammaAngles[nG - 1] as number;
  if (gamma < gLo - 1e-9 || gamma > gHi + 1e-9) return 0;

  // Evenly spaced angles — which real files essentially always have — turn the
  // binary search into a divide. This is the solver's inner loop; on a 180-plane
  // ETC file the two searches were about eight iterations each, per sample,
  // per fixture.
  let gi: number;
  let gt: number;
  if (p.gammaStep !== undefined) {
    const at = (clamp(gamma, gLo, gHi) - gLo) / p.gammaStep;
    gi = at | 0;
    if (gi >= nG - 1) {
      gi = nG - 1;
      gt = 0;
    } else {
      gt = at - gi;
    }
  } else {
    const found = bracket(gammaAngles, clamp(gamma, gLo, gHi));
    gi = found.i;
    gt = found.t;
  }

  if (nC === 1) {
    // Rotationally symmetric: one C plane covers everything.
    return lerp(candela[gi] as number, candela[Math.min(gi + 1, nG - 1)] as number, gt);
  }

  // C wraps at 360. The parser guarantees ascending angles starting at 0.
  const cw = ((c % 360) + 360) % 360;
  let ci: number;
  let ct: number;
  if (p.cStep !== undefined) {
    const at = cw / p.cStep;
    ci = at | 0;
    if (ci >= nC) ci = nC - 1;
    ct = at - ci;
  } else {
    const found = bracketCyclic(cAngles, cw);
    ci = found.i;
    ct = found.t;
  }
  const ciNext = (ci + 1) % nC;

  const a = lerp(
    candela[ci * nG + gi] as number,
    candela[ci * nG + Math.min(gi + 1, nG - 1)] as number,
    gt,
  );
  const b = lerp(
    candela[ciNext * nG + gi] as number,
    candela[ciNext * nG + Math.min(gi + 1, nG - 1)] as number,
    gt,
  );
  return lerp(a, b, ct);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * The common spacing of an evenly spaced ascending list, or `undefined`.
 *
 * Used at parse time to let the interpolator index directly instead of
 * searching. The tolerance is absolute and tight (1e-6°): a file whose angles
 * drift would give wrong answers under direct indexing, so anything but
 * genuinely uniform must fall back to the search.
 */
export function uniformStep(xs: number[]): number | undefined {
  if (xs.length < 2) return undefined;

  const step = (xs[1] as number) - (xs[0] as number);
  if (!(step > 0)) return undefined;

  for (let i = 2; i < xs.length; i++) {
    const expected = (xs[0] as number) + step * i;
    if (Math.abs((xs[i] as number) - expected) > 1e-6) return undefined;
  }
  return step;
}

/**
 * Attach uniform-step hints to a tabulated distribution, if its angles qualify.
 *
 * The C hint additionally requires the planes to start at 0 and to wrap evenly
 * back round to 360, because the interpolator indexes `c / cStep` with no
 * offset and treats the last interval as wrapping to the first plane.
 */
export function withUniformSteps(p: TabulatedPhotometry): TabulatedPhotometry {
  const gammaStep = uniformStep(p.gammaAngles);

  let cStep = uniformStep(p.cAngles);
  if (cStep !== undefined) {
    const startsAtZero = Math.abs(p.cAngles[0] as number) < 1e-6;
    const wrapsEvenly = Math.abs(cStep * p.cAngles.length - 360) < 1e-6;
    if (!startsAtZero || !wrapsEvenly) cStep = undefined;
  }

  return {
    ...p,
    ...(gammaStep !== undefined ? { gammaStep } : {}),
    ...(cStep !== undefined ? { cStep } : {}),
  };
}

/** Index of the sample at or below `v`, plus the fraction toward the next. */
function bracket(xs: number[], v: number): { i: number; t: number } {
  const n = xs.length;
  if (n === 1 || v <= (xs[0] as number)) return { i: 0, t: 0 };
  if (v >= (xs[n - 1] as number)) return { i: n - 1, t: 0 };

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) <= v) lo = mid;
    else hi = mid;
  }
  const a = xs[lo] as number;
  const b = xs[hi] as number;
  return { i: lo, t: b > a ? (v - a) / (b - a) : 0 };
}

/** As {@link bracket}, but the last interval wraps around to the first sample. */
function bracketCyclic(xs: number[], v: number): { i: number; t: number } {
  const n = xs.length;
  const last = xs[n - 1] as number;
  if (v >= last) {
    const span = 360 - last + (xs[0] as number);
    return { i: n - 1, t: span > 0 ? (v - last) / span : 0 };
  }
  return bracket(xs, v);
}

// ---------------------------------------------------------------------------
// Characterisation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Solver acceleration
// ---------------------------------------------------------------------------

/**
 * Entries in a cosine-space intensity table. 2048 keeps the worst-case
 * interpolation error near 1e-6 of peak while costing 8 kB a fixture.
 */
export const COS_TABLE_SIZE = 2048;

/** A sampling of `I(gamma)` indexed by `cos gamma`, for the solver's hot loop. */
export interface CosTable {
  /** `cos` of the cutoff angle — the low end of the table. */
  cosMin: number;
  /** Reciprocal of the sample spacing in cos-space. */
  invStep: number;
  values: Float32Array;
}

/**
 * Tabulate a rotationally symmetric analytic beam against **cos gamma**.
 *
 * The solver already has `cos gamma` in hand — it is a dot product — and
 * currently spends an `acos`, a `Math.pow` and a `Math.exp` per sample to turn
 * that into an intensity. All three collapse into one table lookup.
 *
 * Sampling in cosine space rather than in gamma is what makes this accurate
 * rather than merely fast. Near the beam axis `cos gamma ~ 1 - gamma^2 / 2`, so
 * `gamma^2 ~ 2(1 - cos gamma)`, and for the n ~ 2 exponent real optics have,
 *
 *     I ~ peak * (1 - k * gamma^2) ~ peak * (1 - 2k * (1 - cos gamma))
 *
 * — i.e. *linear* in cos gamma exactly where the beam is brightest and where
 * error would matter most. Sampling uniformly in gamma would instead crowd
 * samples into the axis, where the function is flattest, and starve the
 * shoulder, where it is not.
 *
 * Only for rotationally symmetric beams. An elliptical one varies with the C
 * plane too and cannot be reduced to a single curve; those keep the exact path.
 */
export function buildCosTable(p: AnalyticPhotometry): CosTable {
  const cosMin = Math.cos(Math.min(p.cutoffGamma, 180) * DEG);
  const span = 1 - cosMin;
  const values = new Float32Array(COS_TABLE_SIZE + 1);

  if (span <= 0) {
    values.fill(p.peakCandela);
    return { cosMin, invStep: 0, values };
  }

  for (let i = 0; i <= COS_TABLE_SIZE; i++) {
    const cosGamma = cosMin + (span * i) / COS_TABLE_SIZE;
    const gamma = Math.acos(cosGamma > 1 ? 1 : cosGamma) * RAD;
    values[i] = gamma >= p.cutoffGamma ? 0 : p.peakCandela * Math.exp(-p.k * Math.pow(gamma, p.n));
  }

  return { cosMin, invStep: COS_TABLE_SIZE / span, values };
}

/** Sample a {@link CosTable}. `cosGamma` must already be above `cosMin`. */
export function sampleCosTable(table: CosTable, cosGamma: number): number {
  const at = (cosGamma - table.cosMin) * table.invStep;
  const i = at | 0;
  if (i >= COS_TABLE_SIZE) return table.values[COS_TABLE_SIZE] as number;
  if (i < 0) return 0;
  const a = table.values[i] as number;
  return a + ((table.values[i + 1] as number) - a) * (at - i);
}

/** Peak candela anywhere in the distribution. */
export function peakCandela(p: Photometry): number {
  if (p.kind === 'analytic') return p.peakCandela;
  let max = 0;
  for (const v of p.candela) if (v > max) max = v;
  return max;
}

/**
 * Total flux, lumens, by integrating the distribution over the sphere:
 *
 *   Φ = ∫∫ I(C, γ) · sin γ · dγ · dC
 *
 * Trapezoidal in gamma, rectangular in C. This is what turns a candela table
 * into "this fixture puts out N lumens", and it is the check that a parsed IES
 * file is sane: a file whose integrated flux is wildly different from its
 * declared lamp lumens has usually been read with the wrong angle ordering.
 */
export function integrateFlux(p: Photometry, steps = 720): number {
  const dGamma = 180 / steps;
  const cSteps = p.kind === 'analytic' ? 36 : Math.max(p.cAngles.length, 4);
  const dC = 360 / cSteps;

  let total = 0;
  for (let ci = 0; ci < cSteps; ci++) {
    const c = ci * dC;
    let planeSum = 0;
    for (let gi = 0; gi <= steps; gi++) {
      const gamma = gi * dGamma;
      const w = gi === 0 || gi === steps ? 0.5 : 1;
      planeSum += w * intensityAt(p, c, gamma) * Math.sin(gamma * DEG);
    }
    total += planeSum * dGamma * DEG;
  }
  return total * dC * DEG;
}

/**
 * Flux emitted inside a cone of half-angle `maxGamma`, lumens.
 *
 * The reason this exists: entertainment datasheets quote **field lumens** — the
 * flux inside the field angle — not total flux. Treating one as the other
 * under-predicts centre-beam candela by about 10%, consistently, across every
 * fixture in the calibration set, because the tail outside the field angle
 * really does carry roughly that much of the light.
 */
export function fluxWithin(p: Photometry, maxGamma: number, steps = 720): number {
  const limit = Math.min(Math.max(maxGamma, 0), 180);
  const dGamma = limit / steps;
  if (dGamma <= 0) return 0;

  const cSteps = p.kind === 'analytic' ? 36 : Math.max(p.cAngles.length, 4);
  const dC = 360 / cSteps;

  let total = 0;
  for (let ci = 0; ci < cSteps; ci++) {
    const c = ci * dC;
    let planeSum = 0;
    for (let gi = 0; gi <= steps; gi++) {
      const gamma = gi * dGamma;
      const w = gi === 0 || gi === steps ? 0.5 : 1;
      planeSum += w * intensityAt(p, c, gamma) * Math.sin(gamma * DEG);
    }
    total += planeSum * dGamma * DEG;
  }
  return total * dC * DEG;
}

/**
 * Full angle in degrees at which intensity falls to `fraction` of peak,
 * averaged over the C planes. `fraction` is 0.5 for the beam angle and 0.1 for
 * the field angle, which is the entertainment-industry convention (and the CIE
 * one).
 *
 * Walks outward from the axis and takes the **first** crossing. A distribution
 * that comes back up further out — a fresnel with a spill ring, or a badly
 * sampled file — would otherwise report a field angle covering the spill, which
 * is not the angle anyone means.
 */
export function angleAtFraction(p: Photometry, fraction: number, cPlanes = 8): number {
  const peak = peakCandela(p);
  if (peak <= 0) return 0;
  const threshold = peak * fraction;

  let sum = 0;
  let counted = 0;
  for (let i = 0; i < cPlanes; i++) {
    const c = (i / cPlanes) * 360;
    const half = firstCrossing(p, c, threshold);
    if (half > 0) {
      sum += half;
      counted++;
    }
  }
  return counted === 0 ? 0 : (sum / counted) * 2;
}

function firstCrossing(p: Photometry, c: number, threshold: number): number {
  const step = 0.25;
  let prevAngle = 0;
  let prevValue = intensityAt(p, c, 0);
  // A distribution whose on-axis value is already below the threshold is not
  // peaked on axis (a cyc unit, say). Its "beam angle" is meaningless, so
  // report nothing rather than 0.
  if (prevValue < threshold) return 0;

  for (let gamma = step; gamma <= 180; gamma += step) {
    const v = intensityAt(p, c, gamma);
    if (v < threshold) {
      const span = prevValue - v;
      const t = span > 1e-12 ? (prevValue - threshold) / span : 0;
      return prevAngle + t * step;
    }
    prevAngle = gamma;
    prevValue = v;
  }
  return 180;
}

/**
 * Rescale an analytic distribution to a new field angle, conserving flux.
 *
 * This is what a zoom knob does: the same lumens spread over a different solid
 * angle, so peak candela falls as the beam widens. Flux is held constant rather
 * than peak candela — the opposite would make a fixture brighter overall the
 * wider you zoom it, which is not a thing.
 *
 * Only defined for analytic photometry. A tabulated (measured) distribution
 * describes one zoom position and cannot honestly be stretched to another; the
 * library carries a separate optic per measured zoom step instead.
 */
export function scaleZoom(p: AnalyticPhotometry, newFieldAngle: number): AnalyticPhotometry {
  const oldField = fieldAngleOf(p);
  if (oldField <= 0 || newFieldAngle <= 0) return p;

  const ratio = newFieldAngle / oldField;

  // k has units of degrees^-n, so widening the beam by `ratio` divides k by
  // ratio^n. Peak candela then falls by roughly ratio^2, since the same flux is
  // spread over that much more solid angle — but only *roughly*: that relation
  // assumes sin γ ≈ γ, and a beam zoomed out to 45° is well past where that
  // holds (it is 0.8% out there, and worse wider still).
  //
  // So the scaling sets the shape and the flux integral sets the level. Flux is
  // the physically conserved quantity when you zoom a fixture — the lamp does
  // not get brighter because you widened the beam — and pinning it exactly
  // costs one integration per zoom change, which happens on user input, not on
  // the solver's hot path.
  const shaped: AnalyticPhotometry = {
    ...p,
    k: p.k / Math.pow(ratio, p.n),
    kCross: p.kCross / Math.pow(ratio, p.n),
    peakCandela: 1,
    cutoffGamma: Math.min(p.cutoffGamma * ratio, 180),
  };

  const unitFlux = integrateFlux(shaped);
  const wantedFlux = integrateFlux(p);

  return {
    ...shaped,
    peakCandela: unitFlux > 1e-12 ? wantedFlux / unitFlux : p.peakCandela / (ratio * ratio),
  };
}

/** Field angle (10% of peak, full angle) of an analytic distribution, closed form. */
export function fieldAngleOf(p: AnalyticPhotometry): number {
  return 2 * Math.pow(Math.LN10 / p.k, 1 / p.n);
}

/** Beam angle (50% of peak, full angle) of an analytic distribution, closed form. */
export function beamAngleOf(p: AnalyticPhotometry): number {
  return 2 * Math.pow(Math.LN2 / p.k, 1 / p.n);
}
