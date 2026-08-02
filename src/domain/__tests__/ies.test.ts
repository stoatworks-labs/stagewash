import { describe, expect, it } from 'vitest';

import { angleAtFraction, intensityAt } from '../photometry/distribution';
import { IesParseError, parseIes } from '../photometry/ies';

/**
 * Build a synthetic LM-63 file. Everything the parser is asked to do is
 * exercised against a table we know the answer to, so a failure points at the
 * reader rather than at a vendor's file.
 */
function buildIes(options: {
  version?: string;
  keywords?: Record<string, string>;
  tilt?: string;
  lampCount?: number;
  lumensPerLamp?: number;
  candelaMultiplier?: number;
  photometricType?: number;
  unitsType?: number;
  ballastFactor?: number;
  futureFactor?: number;
  verticalAngles: number[];
  horizontalAngles: number[];
  /** Candela, indexed [horizIndex][vertIndex]. */
  candela: number[][];
  /** Put the candela block on one very long line, as some writers do. */
  wrapCandela?: boolean;
}): string {
  const {
    version = 'IESNA:LM-63-2002',
    keywords = { TEST: 'SYNTH-1', MANUFAC: 'Stagewash Test Rig' },
    tilt = 'TILT=NONE',
    lampCount = 1,
    lumensPerLamp = 10_000,
    candelaMultiplier = 1,
    photometricType = 1,
    unitsType = 2,
    ballastFactor = 1,
    futureFactor = 1,
    verticalAngles,
    horizontalAngles,
    candela,
    wrapCandela = true,
  } = options;

  const lines: string[] = [version];
  for (const [k, v] of Object.entries(keywords)) lines.push(`[${k}] ${v}`);
  lines.push(tilt);
  lines.push(
    [
      lampCount,
      lumensPerLamp,
      candelaMultiplier,
      verticalAngles.length,
      horizontalAngles.length,
      photometricType,
      unitsType,
      0,
      0,
      0,
    ].join(' '),
  );
  lines.push([ballastFactor, futureFactor, 750].join(' '));
  lines.push(verticalAngles.join(' '));
  lines.push(horizontalAngles.join(' '));

  const flat = candela.flat();
  if (wrapCandela) {
    for (let i = 0; i < flat.length; i += 7) lines.push(flat.slice(i, i + 7).join(' '));
  } else {
    lines.push(flat.join(' '));
  }

  return lines.join('\r\n');
}

/** A rotationally symmetric Gaussian beam, sampled every degree to 90°. */
function gaussianBeam(peak: number, halfAngleAt50: number) {
  const verticalAngles = Array.from({ length: 91 }, (_, i) => i);
  const k = Math.LN2 / (halfAngleAt50 * halfAngleAt50);
  const plane = verticalAngles.map((g) => peak * Math.exp(-k * g * g));
  return { verticalAngles, horizontalAngles: [0], candela: [plane] };
}

describe('parseIes', () => {
  it('reads a rotationally symmetric file and recovers the beam', () => {
    const beam = gaussianBeam(100_000, 7);
    const file = parseIes(buildIes(beam));

    expect(file.photometrics.peakCandela).toBeCloseTo(100_000, 6);
    expect(file.photometrics.provenance).toBe('measured');
    // Half-angle 7° at 50% means a 14° beam angle.
    expect(file.photometrics.beamAngle).toBeCloseTo(14, 1);
    expect(file.keywords['MANUFAC']).toBe('Stagewash Test Rig');
    expect(file.declaredLumens).toBe(10_000);
  });

  it('does not care how the numbers are split across lines', () => {
    const beam = gaussianBeam(50_000, 10);
    const wrapped = parseIes(buildIes({ ...beam, wrapCandela: true }));
    const oneLine = parseIes(buildIes({ ...beam, wrapCandela: false }));

    expect(oneLine.photometrics.peakCandela).toBeCloseTo(
      wrapped.photometrics.peakCandela,
      6,
    );
  });

  it('applies the candela multiplier and both ballast factors', () => {
    const beam = gaussianBeam(1000, 10);
    const file = parseIes(
      buildIes({ ...beam, candelaMultiplier: 2, ballastFactor: 3, futureFactor: 5 }),
    );

    expect(file.photometrics.peakCandela).toBeCloseTo(1000 * 2 * 3 * 5, 6);
  });

  it('treats a zero factor as 1 and says so, rather than zeroing the fixture', () => {
    const beam = gaussianBeam(1000, 10);
    const file = parseIes(buildIes({ ...beam, ballastFactor: 0 }));

    expect(file.photometrics.peakCandela).toBeCloseTo(1000, 6);
    expect(file.warnings.join(' ')).toMatch(/ballast factor was 0/i);
  });

  it('rejects Type B rather than misreading its angles', () => {
    const beam = gaussianBeam(1000, 10);
    expect(() => parseIes(buildIes({ ...beam, photometricType: 2 }))).toThrow(IesParseError);
    expect(() => parseIes(buildIes({ ...beam, photometricType: 2 }))).toThrow(/Type B/);
  });

  it('rejects a file with no TILT line', () => {
    expect(() => parseIes('IESNA:LM-63-2002\n[TEST] nothing else\n')).toThrow(
      /LM-63/,
    );
  });

  it('steps over an embedded TILT block without eating the header', () => {
    const beam = gaussianBeam(100_000, 7);
    const withTilt = buildIes(beam).replace(
      'TILT=NONE',
      ['TILT=INCLUDE', '1', '4', '0 30 60 90', '1.0 0.95 0.9 0.85'].join('\r\n'),
    );

    const file = parseIes(withTilt);
    expect(file.photometrics.peakCandela).toBeCloseTo(100_000, 6);
    expect(file.warnings.join(' ')).toMatch(/TILT block/i);
  });

  it('converts luminous dimensions from feet when the file says feet', () => {
    const beam = gaussianBeam(1000, 10);
    const ies = buildIes(beam).replace('1 10000 1 91 1 1 2 0 0 0', '1 10000 1 91 1 1 1 1 2 3');

    const file = parseIes(ies);
    expect(file.dimensions.width).toBeCloseTo(0.3048, 4);
    expect(file.dimensions.length).toBeCloseTo(0.6096, 4);
  });

  it('reads absolute photometry (lumens per lamp of -1) and flags it', () => {
    const beam = gaussianBeam(1000, 10);
    const file = parseIes(buildIes({ ...beam, lumensPerLamp: -1 }));

    expect(file.declaredLumens).toBe(-1);
    expect(file.warnings.join(' ')).toMatch(/absolute photometry/i);
  });
});

describe('symmetry expansion', () => {
  const verticalAngles = [0, 15, 30, 45, 60, 75, 90];

  /** Intensity that varies with C so mirroring is observable. */
  const planeFor = (value: number) => verticalAngles.map((_, i) => value * (1 - i / 12));

  it('mirrors a quadrant file into all four quadrants', () => {
    // 0..90 in 30° steps, rising with C.
    const horizontalAngles = [0, 30, 60, 90];
    const candela = [planeFor(1000), planeFor(2000), planeFor(3000), planeFor(4000)];
    const file = parseIes(buildIes({ verticalAngles, horizontalAngles, candela }));

    const p = file.photometrics.photometry;
    // C=30 is the 2000 plane; its mirror at C=150 must match, and so must
    // C=210 and C=330.
    const ref = intensityAt(p, 30, 0);
    expect(ref).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 150, 0)).toBeCloseTo(ref, 6);
    expect(intensityAt(p, 210, 0)).toBeCloseTo(ref, 6);
    expect(intensityAt(p, 330, 0)).toBeCloseTo(ref, 6);
  });

  it('mirrors a half file about the 0–180 plane', () => {
    const horizontalAngles = [0, 45, 90, 135, 180];
    const candela = [
      planeFor(1000),
      planeFor(2000),
      planeFor(3000),
      planeFor(4000),
      planeFor(5000),
    ];
    const file = parseIes(buildIes({ verticalAngles, horizontalAngles, candela }));
    const p = file.photometrics.photometry;

    expect(intensityAt(p, 45, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 315, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 135, 0)).toBeCloseTo(4000, 6);
    expect(intensityAt(p, 225, 0)).toBeCloseTo(4000, 6);
  });

  it('drops the duplicate 360 plane from a fully asymmetric file', () => {
    const horizontalAngles = [0, 90, 180, 270, 360];
    const candela = [
      planeFor(1000),
      planeFor(2000),
      planeFor(3000),
      planeFor(4000),
      planeFor(1000),
    ];
    const file = parseIes(buildIes({ verticalAngles, horizontalAngles, candela }));
    const p = file.photometrics.photometry;

    expect(p.kind).toBe('tabulated');
    if (p.kind !== 'tabulated') throw new Error('unreachable');
    expect(p.cAngles).toEqual([0, 90, 180, 270]);
    expect(intensityAt(p, 270, 0)).toBeCloseTo(4000, 6);
    // Interpolating across the wrap must come back to the 0 plane.
    expect(intensityAt(p, 359.999, 0)).toBeCloseTo(1000, 1);
  });
});

describe('sampling a tabulated distribution', () => {
  it('returns zero above the last measured gamma rather than smearing the edge', () => {
    // A file that stops at 90° stops because the fixture emits nothing above
    // it. Clamping instead would light the stage from a downlight's back.
    const beam = gaussianBeam(100_000, 7);
    const p = parseIes(buildIes(beam)).photometrics.photometry;

    expect(intensityAt(p, 0, 90)).toBeGreaterThanOrEqual(0);
    expect(intensityAt(p, 0, 90.5)).toBe(0);
    expect(intensityAt(p, 0, 170)).toBe(0);
  });

  it('interpolates between samples', () => {
    const verticalAngles = [0, 10];
    const file = parseIes(
      buildIes({ verticalAngles, horizontalAngles: [0], candela: [[1000, 2000]] }),
    );
    const p = file.photometrics.photometry;

    expect(intensityAt(p, 0, 0)).toBeCloseTo(1000, 6);
    expect(intensityAt(p, 0, 5)).toBeCloseTo(1500, 6);
    expect(intensityAt(p, 0, 10)).toBeCloseTo(2000, 6);
  });

  it('measures the beam angle off a measured table the same way as an analytic one', () => {
    const beam = gaussianBeam(100_000, 12);
    const p = parseIes(buildIes(beam)).photometrics.photometry;

    expect(angleAtFraction(p, 0.5)).toBeCloseTo(24, 1);
  });
});
