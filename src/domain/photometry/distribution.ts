/**
 * Sampling and characterising luminous intensity distributions.
 *
 * A `Photometry` is plain data (so it can cross a worker boundary); everything
 * that interprets it lives here as a pure function.
 */

import { DEG, clamp } from '../geometry';
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

  const { i: gi, t: gt } = bracket(gammaAngles, clamp(gamma, gLo, gHi));

  if (nC === 1) {
    // Rotationally symmetric: one C plane covers everything.
    return lerp(candela[gi] as number, candela[Math.min(gi + 1, nG - 1)] as number, gt);
  }

  // C wraps at 360. The parser guarantees ascending angles starting at 0.
  const cw = ((c % 360) + 360) % 360;
  const { i: ci, t: ct } = bracketCyclic(cAngles, cw);
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
