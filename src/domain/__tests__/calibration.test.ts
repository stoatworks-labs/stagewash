import { describe, expect, it } from 'vitest';

import { FIXTURE_LIBRARY } from '../../data/fixtures';
import { LAMP_INDEX } from '../../data/lamps';
import { integrateFlux } from '../photometry/distribution';
import { estimatePhotometrics } from '../photometry/estimator';

/**
 * Published photometric rows, transcribed from ETC datasheets.
 *
 * This is the calibration set. It is the reason `OPTICAL_EFFICIENCY` and
 * `TYPICAL_BEAM_FIELD_RATIO` hold the values they do, and the reason anyone
 * should believe a number this app produces for a fixture nobody measured.
 *
 * **Fix the model, never the table.** If a change here makes a test pass, the
 * change is wrong.
 */
const PUBLISHED = [
  {
    fixture: 'Source Four 36°',
    kind: 'profile' as const,
    lampLumens: 21_900,
    beamAngle: 27,
    fieldAngle: 34,
    centreBeamCandela: 90_885,
    fieldLumens: 14_240,
    efficiency: 0.65,
    source: 'ETC Source Four 36° datasheet',
  },
  {
    fixture: 'Source Four jr 26°',
    kind: 'profile' as const,
    lampLumens: 16_520,
    beamAngle: 20,
    fieldAngle: 25,
    centreBeamCandela: 91_480,
    fieldLumens: 7_795,
    efficiency: 0.472,
    source: 'ETC Source Four jr 26° datasheet',
  },
  {
    fixture: 'Source Four Zoom @ 15°',
    kind: 'profile' as const,
    lampLumens: 21_900,
    beamAngle: 11,
    fieldAngle: 16,
    centreBeamCandela: 395_560,
    fieldLumens: 11_460,
    efficiency: 0.523,
    source: 'ETC Source Four Zoom 15°–30° datasheet',
  },
  {
    fixture: 'Source Four Zoom @ 23°',
    kind: 'profile' as const,
    lampLumens: 21_900,
    beamAngle: 16,
    fieldAngle: 23,
    centreBeamCandela: 181_685,
    fieldLumens: 12_315,
    efficiency: 0.562,
    source: 'ETC Source Four Zoom 15°–30° datasheet',
  },
  {
    fixture: 'Source Four Zoom @ 30°',
    kind: 'profile' as const,
    lampLumens: 21_900,
    beamAngle: 21,
    fieldAngle: 31,
    centreBeamCandela: 105_690,
    fieldLumens: 11_960,
    efficiency: 0.546,
    source: 'ETC Source Four Zoom 15°–30° datasheet',
  },
  {
    fixture: 'Source Four PAR MCM VNSP',
    kind: 'par' as const,
    // The PAR MCM sheet measures with an HPL 575, unlike the rest of the range.
    lampLumens: 16_520,
    beamAngle: 8,
    fieldAngle: 16,
    centreBeamCandela: 343_440,
    fieldLumens: 7_798,
    efficiency: 0.472,
    source: 'ETC Source Four PAR MCM datasheet',
  },
  {
    fixture: 'Source Four PARNel spot',
    kind: 'fresnel' as const,
    lampLumens: 21_900,
    beamAngle: 12,
    fieldAngle: 24,
    centreBeamCandela: 190_390,
    fieldLumens: 9_135,
    efficiency: 0.417,
    source: 'ETC Source Four PARNel datasheet',
  },
  {
    fixture: 'Source Four PARNel flood',
    kind: 'fresnel' as const,
    lampLumens: 21_900,
    beamAngle: 29,
    fieldAngle: 47,
    centreBeamCandela: 47_050,
    fieldLumens: 10_560,
    efficiency: 0.482,
    source: 'ETC Source Four PARNel datasheet',
  },
];

describe('the datasheets are internally consistent', () => {
  it.each(PUBLISHED)(
    '$fixture: quoted efficiency matches field lumens over lamp lumens',
    ({ fieldLumens, lampLumens, efficiency }) => {
      expect(fieldLumens / lampLumens).toBeCloseTo(efficiency, 2);
    },
  );
});

describe('the shape model, given the manufacturer’s own flux', () => {
  /**
   * The strongest claim this app makes about fixtures it has not measured: fed
   * the field lumens a datasheet quotes, plus the beam and field angles it
   * quotes, the super-Gaussian shape reproduces the centre-beam candela it
   * quotes.
   *
   * Nothing here is fitted to the answer — the shape comes from the two angles
   * alone and the scale comes from the flux alone. Agreement means the shape is
   * right.
   */
  it.each(PUBLISHED)(
    '$fixture: predicts centre-beam candela within 12%',
    ({ kind, beamAngle, fieldAngle, fieldLumens, centreBeamCandela }) => {
      const estimated = estimatePhotometrics({
        kind,
        beamAngle,
        fieldAngle,
        lumens: fieldLumens,
        lumensAtLens: true, // field lumens are already at the lens
        lumensBasis: 'field',
      });

      const error = Math.abs(estimated.peakCandela - centreBeamCandela) / centreBeamCandela;
      expect(error).toBeLessThan(0.12);
    },
  );

  it('is unbiased, which is the property that says the shape is right', () => {
    // Measured across the eight fixtures: mean -3.3%, worst 10.5%.
    //
    // Before `lumensBasis` existed this was mean -9.4%, worst 14.9% — every
    // single fixture low, which is the signature of a systematic error rather
    // than of model noise. The cause was reading the datasheets' field lumens
    // as total flux. Fixing that is what took the mean to -3.3%, and the
    // remaining scatter is genuinely two-sided.
    const errors = PUBLISHED.map(({ kind, beamAngle, fieldAngle, fieldLumens, centreBeamCandela }) => {
      const estimated = estimatePhotometrics({
        kind,
        beamAngle,
        fieldAngle,
        lumens: fieldLumens,
        lumensAtLens: true,
        lumensBasis: 'field',
      });
      return (estimated.peakCandela - centreBeamCandela) / centreBeamCandela;
    });

    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    expect(Math.abs(mean)).toBeLessThan(0.06);

    // And it must not be one-sided.
    expect(errors.some((e) => e > 0)).toBe(true);
    expect(errors.some((e) => e < 0)).toBe(true);
  });
});

describe('the full estimator, from bare-lamp lumens', () => {
  /**
   * The weaker claim, and the honest one: starting from nothing but the *lamp*
   * and the two angles — which is all a user typing in a custom fixture has —
   * the estimate lands within 25%. Measured: mean -2.4%, worst -23.7%.
   *
   * 25% is not a good number, and it is not meant to look like one. It is
   * dominated by `OPTICAL_EFFICIENCY`, which is a single figure standing in for
   * a range that really runs from 42% to 65% across these eight fixtures — and
   * the worst case here is exactly that, the Source Four 36° at a genuine 65%
   * being estimated at the table's 55%. That spread is a property of real
   * fixtures, not of the model, and no amount of work on the shape function
   * will close it. It is why estimated fixtures are badged as estimates in the
   * UI, and why the answer to "I need this to be right" is always "import the
   * IES file".
   */
  it.each(PUBLISHED)(
    '$fixture: lands within 25% from lamp lumens alone',
    ({ kind, beamAngle, fieldAngle, lampLumens, centreBeamCandela }) => {
      const estimated = estimatePhotometrics({ kind, beamAngle, fieldAngle, lumens: lampLumens });

      const error = Math.abs(estimated.peakCandela - centreBeamCandela) / centreBeamCandela;
      expect(error).toBeLessThan(0.25);
    },
  );

  it('is unbiased across the calibration set', () => {
    // Individually the estimates can be a third out either way. Collectively
    // they must not lean — a systematic bias would mean OPTICAL_EFFICIENCY is
    // simply set wrong, which is exactly the bug that shipped in the first
    // version of this table (28% for a profile, out by a factor of two).
    const ratios = PUBLISHED.map(({ kind, beamAngle, fieldAngle, lampLumens, centreBeamCandela }) => {
      const estimated = estimatePhotometrics({ kind, beamAngle, fieldAngle, lumens: lampLumens });
      return estimated.peakCandela / centreBeamCandela;
    });

    const geometricMean = Math.exp(
      ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length,
    );
    expect(geometricMean).toBeGreaterThan(0.92);
    expect(geometricMean).toBeLessThan(1.08);
  });
});

describe('the zoom model, against three measured positions of one fixture', () => {
  const zoom = PUBLISHED.filter((p) => p.fixture.startsWith('Source Four Zoom'));

  it('confirms flux is what stays constant when you zoom, not intensity', () => {
    // 11,460 / 12,315 / 11,960 field lumens across 16° / 23° / 31°. Within 7%
    // of each other while centre-beam candela changes by a factor of 3.7.
    const flux = zoom.map((z) => z.fieldLumens);
    const min = Math.min(...flux);
    const max = Math.max(...flux);
    expect((max - min) / min).toBeLessThan(0.08);
  });

  it('confirms peak candela falls as the square of the field angle', () => {
    const [narrow, , wide] = zoom;
    if (!narrow || !wide) throw new Error('calibration set changed');

    const angleRatio = wide.fieldAngle / narrow.fieldAngle;
    const candelaRatio = narrow.centreBeamCandela / wide.centreBeamCandela;

    // 31/16 = 1.94, squared = 3.75. Measured 395,560 / 105,690 = 3.74.
    expect(candelaRatio).toBeCloseTo(angleRatio * angleRatio, 1);
  });
});

describe('library integrity', () => {
  it('gives every optic a provenance and a real source', () => {
    for (const model of FIXTURE_LIBRARY) {
      expect(model.optics.length).toBeGreaterThan(0);
      for (const optic of model.optics) {
        const { provenance, source } = optic.photometrics;
        expect(['measured', 'published', 'estimated']).toContain(provenance);
        expect(source.length).toBeGreaterThan(20);
      }
    }
  });

  it('names every published entry’s datasheet', () => {
    const published = FIXTURE_LIBRARY.flatMap((m) => m.optics).filter(
      (o) => o.photometrics.provenance === 'published',
    );

    expect(published.length).toBeGreaterThan(0);
    for (const optic of published) {
      expect(optic.photometrics.source).toMatch(/datasheet/i);
    }
  });

  it('never dresses an archetype up as a real product', () => {
    // The rule this file is built on: an estimated entry is generically named
    // and says so. A user must never see a manufacturer's name against a
    // number nobody published.
    for (const model of FIXTURE_LIBRARY) {
      const anyEstimated = model.optics.some((o) => o.photometrics.provenance === 'estimated');
      if (anyEstimated) {
        expect(model.manufacturer).toBe('Generic');
        for (const optic of model.optics) {
          expect(optic.photometrics.source).toMatch(/archetype|not a specific product/i);
        }
      }
    }
  });

  it('gives every fixture a lamp that exists, when it names one', () => {
    for (const model of FIXTURE_LIBRARY) {
      if (model.lampId !== undefined) {
        expect(LAMP_INDEX.has(model.lampId)).toBe(true);
      }
    }
  });

  it('produces a usable distribution for every optic', () => {
    for (const model of FIXTURE_LIBRARY) {
      for (const optic of model.optics) {
        expect(optic.photometrics.peakCandela).toBeGreaterThan(0);
        expect(integrateFlux(optic.photometrics.photometry)).toBeGreaterThan(0);
        expect(optic.photometrics.fieldAngle).toBeGreaterThan(0);
        expect(optic.photometrics.beamAngle).toBeLessThan(optic.photometrics.fieldAngle);
      }
    }
  });

  it('keeps zoom ranges consistent with the optic they sit on', () => {
    for (const model of FIXTURE_LIBRARY) {
      for (const optic of model.optics) {
        if (optic.zoomMin === undefined) continue;
        expect(optic.zoomMax).toBeDefined();
        expect(optic.zoomMin).toBeLessThan(optic.zoomMax as number);
      }
    }
  });

  it('has unique ids', () => {
    const ids = FIXTURE_LIBRARY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const model of FIXTURE_LIBRARY) {
      const opticIds = model.optics.map((o) => o.id);
      expect(new Set(opticIds).size).toBe(opticIds.length);
    }
  });
});
