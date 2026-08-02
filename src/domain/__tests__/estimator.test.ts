import { describe, expect, it } from 'vitest';

import {
  beamAngleOf,
  fieldAngleOf,
  fluxWithin,
  integrateFlux,
  intensityAt,
  scaleZoom,
} from '../photometry/distribution';
import {
  candelaFromLuxAtDistance,
  estimatePhotometrics,
  fitBeamShape,
  illuminance,
} from '../photometry/estimator';
import type { AnalyticPhotometry } from '../types';

describe('fitBeamShape', () => {
  it('puts the fitted curve through both anchor points', () => {
    const beam = 14;
    const field = 26;
    const { n, k } = fitBeamShape(beam, field);

    const at = (fullAngle: number) => Math.exp(-k * Math.pow(fullAngle / 2, n));

    expect(at(beam)).toBeCloseTo(0.5, 10);
    expect(at(field)).toBeCloseTo(0.1, 10);
  });

  it('lands near a Gaussian for the beam:field ratios real fixtures have', () => {
    // The claim this test defends: the two-point fit is not free to be silly.
    // Across the whole range of ratios found on datasheets it independently
    // reproduces n ≈ 2, which is what physical optics predicts. If this ever
    // fails, the anchor definitions (50% / 10%) have been changed.
    for (const ratio of [1.6, 1.75, 1.85, 2.0, 2.1]) {
      const { n, suspicious } = fitBeamShape(10, 10 * ratio);
      expect(n).toBeGreaterThan(1.5);
      expect(n).toBeLessThan(2.6);
      expect(suspicious).toBe(false);
    }
  });

  it('flags angles that are too close together instead of exploding', () => {
    const { n, suspicious } = fitBeamShape(20, 20.1);
    expect(Number.isFinite(n)).toBe(true);
    expect(suspicious).toBe(true);
  });
});

describe('estimatePhotometrics', () => {
  it('reports back the beam and field angles it was given', () => {
    const p = estimatePhotometrics({ kind: 'profile', beamAngle: 14, fieldAngle: 26, lumens: 20000 });

    expect(p.beamAngle).toBeCloseTo(14, 3);
    expect(p.fieldAngle).toBeCloseTo(26, 3);
  });

  it('normalises a lamp-based fixture to its FIELD lumens', () => {
    // A 750 W tungsten profile: bare lamp lumens, cut down by the modelled
    // optical efficiency for the fixture kind. 55% for a profile, per
    // OPTICAL_EFFICIENCY, calibrated against the ETC datasheets.
    const lumens = 21_500;
    const p = estimatePhotometrics({ kind: 'profile', beamAngle: 14, fieldAngle: 26, lumens });

    // That 55% is a fraction of *field* lumens — flux inside the field angle —
    // because that is what the datasheets it was calibrated from quote.
    const inField = fluxWithin(p.photometry, p.fieldAngle / 2);
    expect(inField).toBeGreaterThan(lumens * 0.55 * 0.97);
    expect(inField).toBeLessThan(lumens * 0.55 * 1.03);

    // Total flux is necessarily more, because the tail past the field angle is
    // not nothing. About 10% more, which is exactly the bias that reading one
    // as the other used to introduce.
    expect(p.outputLumens).toBeGreaterThan(inField);
    expect(p.outputLumens / inField).toBeGreaterThan(1.02);
    expect(p.outputLumens / inField).toBeLessThan(1.25);

    expect(p.provenance).toBe('estimated');
  });

  it('takes an LED fixture at its published output without an efficiency haircut', () => {
    // An LED fixture's published lumens are an integrating-sphere total, so
    // `lumensAtLens` implies a total basis and the number comes through whole.
    const p = estimatePhotometrics({
      kind: 'wash',
      fieldAngle: 40,
      lumens: 8000,
      lumensAtLens: true,
    });

    expect(p.outputLumens).toBeGreaterThan(8000 * 0.97);
    expect(p.outputLumens).toBeLessThan(8000 * 1.03);
  });

  it('reads the same number differently depending on what it counts', () => {
    const asTotal = estimatePhotometrics({
      kind: 'wash',
      fieldAngle: 40,
      lumens: 8000,
      lumensAtLens: true,
      lumensBasis: 'total',
    });
    const asField = estimatePhotometrics({
      kind: 'wash',
      fieldAngle: 40,
      lumens: 8000,
      lumensAtLens: true,
      lumensBasis: 'field',
    });

    // Same 8,000 lm, but read as field lumens it implies a brighter fixture,
    // because the tail outside the field is extra rather than included.
    expect(asField.peakCandela).toBeGreaterThan(asTotal.peakCandela);
    expect(asField.peakCandela / asTotal.peakCandela).toBeGreaterThan(1.02);
  });

  it('prefers a stated centre-beam candela over an assumed efficiency', () => {
    const p = estimatePhotometrics({
      kind: 'profile',
      beamAngle: 14,
      fieldAngle: 26,
      lumens: 21_500,
      peakCandela: 120_000,
    });

    expect(p.peakCandela).toBe(120_000);
    expect(p.source).toContain('120,000 cd');
  });

  it('converts a lux-at-distance datasheet row to candela', () => {
    // 1000 lux at 10 m is 100,000 cd, by inverse square.
    expect(candelaFromLuxAtDistance(1000, 10)).toBe(100_000);

    const p = estimatePhotometrics({
      kind: 'profile',
      fieldAngle: 26,
      luxAtDistance: { lux: 1000, distanceM: 10 },
    });
    expect(p.peakCandela).toBeCloseTo(100_000, 6);
  });

  it('makes an asymmetric fixture wider on one axis than the other', () => {
    const p = estimatePhotometrics({
      kind: 'cyc',
      fieldAngle: 90,
      fieldAngleCross: 30,
      lumens: 10_000,
      lumensAtLens: true,
    });
    const photo = p.photometry as AnalyticPhotometry;

    // C = 0 is the wide axis, so at 30° off-axis it is still well lit there and
    // nearly dead across it.
    const wide = intensityAt(photo, 0, 30);
    const narrow = intensityAt(photo, 90, 30);
    expect(wide).toBeGreaterThan(narrow * 5);
  });
});

describe('the inverse square and cosine laws', () => {
  it('quarters the illuminance when the distance doubles', () => {
    expect(illuminance(10_000, 5)).toBeCloseTo(400, 9);
    expect(illuminance(10_000, 10)).toBeCloseTo(100, 9);
  });

  it('halves it at 60 degrees of incidence', () => {
    expect(illuminance(10_000, 10, 60)).toBeCloseTo(50, 9);
  });

  it('is zero at grazing incidence', () => {
    expect(illuminance(10_000, 10, 90)).toBeCloseTo(0, 9);
  });
});

describe('scaleZoom', () => {
  it('conserves flux, so widening the beam costs peak intensity', () => {
    const p = estimatePhotometrics({
      kind: 'movingWash',
      fieldAngle: 15,
      lumens: 12_000,
      lumensAtLens: true,
    }).photometry as AnalyticPhotometry;

    const wide = scaleZoom(p, 45);

    expect(fieldAngleOf(wide)).toBeCloseTo(45, 3);
    // Flux is what is actually conserved, and it is conserved exactly.
    expect(integrateFlux(wide)).toBeCloseTo(integrateFlux(p), 4);

    // Three times the angle is nine times the solid angle, so peak falls by
    // about nine — only about, because that relation assumes sin γ ≈ γ and a
    // 45° beam is past where that holds. Within 2% is the honest claim.
    expect(wide.peakCandela).toBeGreaterThan((p.peakCandela / 9) * 0.98);
    expect(wide.peakCandela).toBeLessThan((p.peakCandela / 9) * 1.02);
  });

  it('is exactly flux-conserving even at wide angles, where the ratio-squared rule is not', () => {
    const p = estimatePhotometrics({
      kind: 'movingWash',
      fieldAngle: 10,
      lumens: 20_000,
      lumensAtLens: true,
    }).photometry as AnalyticPhotometry;

    // 70° is far outside the small-angle regime.
    const wide = scaleZoom(p, 70);
    expect(integrateFlux(wide)).toBeCloseTo(integrateFlux(p), 4);
  });

  it('keeps the beam:field relationship when it zooms', () => {
    const p = estimatePhotometrics({
      kind: 'movingWash',
      beamAngle: 9,
      fieldAngle: 15,
      lumens: 12_000,
      lumensAtLens: true,
    }).photometry as AnalyticPhotometry;

    const before = beamAngleOf(p) / fieldAngleOf(p);
    const after = beamAngleOf(scaleZoom(p, 40)) / fieldAngleOf(scaleZoom(p, 40));
    expect(after).toBeCloseTo(before, 6);
  });
});

describe('intensityAt on an analytic distribution', () => {
  it('emits nothing past the cutoff', () => {
    const p = estimatePhotometrics({
      kind: 'profile',
      beamAngle: 14,
      fieldAngle: 26,
      lumens: 20_000,
    }).photometry as AnalyticPhotometry;

    expect(intensityAt(p, 0, p.cutoffGamma + 0.1)).toBe(0);
    expect(intensityAt(p, 0, 179)).toBe(0);
  });

  it('peaks on axis', () => {
    const p = estimatePhotometrics({
      kind: 'profile',
      beamAngle: 14,
      fieldAngle: 26,
      lumens: 20_000,
    }).photometry as AnalyticPhotometry;

    const axis = intensityAt(p, 0, 0);
    for (const gamma of [1, 5, 10, 13, 20]) {
      expect(intensityAt(p, 0, gamma)).toBeLessThan(axis);
    }
    expect(axis).toBeCloseTo(p.peakCandela, 6);
  });
});
