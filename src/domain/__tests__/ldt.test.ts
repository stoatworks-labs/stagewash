import { describe, expect, it } from 'vitest';

import { intensityAt } from '../photometry/distribution';
import { LdtParseError, parseLdt } from '../photometry/ldt';

/**
 * EULUMDAT is positional — one value per line, no keys — so the fixture builder
 * has to lay the file out exactly. Building it here from named options is the
 * only way a failure points at the reader rather than at a miscounted line.
 */
function buildLdt(options: {
  iSym: number;
  mc: number;
  ng: number;
  /** Intensities in cd/1000 lm, [planeIndex][gammaIndex]. */
  stored: number[][];
  lumens?: number;
  conversionFactor?: number;
  iType?: number;
  lampSets?: number;
}): string {
  const {
    iSym,
    mc,
    ng,
    stored,
    lumens = 10_000,
    conversionFactor = 1,
    iType = 1,
    lampSets = 1,
  } = options;

  const lines: string[] = [];
  lines.push('Stagewash Test Rig'); // 1 company
  lines.push(String(iType)); // 2 Ityp
  lines.push(String(iSym)); // 3 Isym
  lines.push(String(mc)); // 4 Mc
  lines.push(String(360 / mc)); // 5 Dc
  lines.push(String(ng)); // 6 Ng
  lines.push(String(180 / (ng - 1))); // 7 Dg
  lines.push('REPORT-1'); // 8
  lines.push('Test Luminaire'); // 9
  lines.push('TL-1'); // 10
  lines.push('test.ldt'); // 11
  lines.push('2026-08-02'); // 12
  for (let i = 13; i <= 22; i++) lines.push('0'); // 13-22 geometry + DFF
  lines.push('100'); // 23 LORL
  lines.push(String(conversionFactor)); // 24 conversion factor
  lines.push('0'); // 25 tilt
  lines.push(String(lampSets)); // 26 number of lamp sets

  for (let s = 0; s < lampSets; s++) {
    lines.push('1'); // number of lamps
    lines.push('LED'); // type
    lines.push(String(lumens)); // total flux, lm
    lines.push('5600'); // CCT
    lines.push('90'); // CRI
    lines.push('200'); // watts
  }

  for (let i = 0; i < 10; i++) lines.push('0'); // direct ratios

  for (let i = 0; i < mc; i++) lines.push(String((i * 360) / mc)); // C angles
  for (let i = 0; i < ng; i++) lines.push(String((i * 180) / (ng - 1))); // gamma angles

  for (const plane of stored) for (const v of plane) lines.push(String(v));

  return lines.join('\r\n');
}

/** Gamma samples every 15° to 180°, peaked on axis. */
const NG = 13;
const planeFor = (peak: number) =>
  Array.from({ length: NG }, (_, i) => (i === 0 ? peak : i <= 2 ? peak / (i + 1) : 0));

describe('parseLdt', () => {
  it('scales cd/1000 lm by the lamp flux', () => {
    // Trap 1. 500 cd/1000 lm on a 10,000 lm lamp is 5,000 cd. A reader that
    // skips this is out by whatever the lamp happens to be.
    const file = parseLdt(
      buildLdt({ iSym: 1, mc: 4, ng: NG, stored: [planeFor(500)], lumens: 10_000 }),
    );

    expect(file.photometrics.peakCandela).toBeCloseTo(5000, 6);
    expect(file.declaredLumens).toBe(10_000);
    expect(file.photometrics.provenance).toBe('measured');
  });

  it('applies the conversion factor on top', () => {
    const file = parseLdt(
      buildLdt({
        iSym: 1,
        mc: 4,
        ng: NG,
        stored: [planeFor(500)],
        lumens: 10_000,
        conversionFactor: 2,
      }),
    );
    expect(file.photometrics.peakCandela).toBeCloseTo(10_000, 6);
  });

  it('reads only one stored plane for a rotationally symmetric fitting', () => {
    // Trap 2. Isym = 1 stores a single plane however large Mc is. Reading Mc
    // planes runs off the end of the file.
    const file = parseLdt(
      buildLdt({ iSym: 1, mc: 24, ng: NG, stored: [planeFor(1000)], lumens: 1000 }),
    );

    const p = file.photometrics.photometry;
    expect(p.kind).toBe('tabulated');
    if (p.kind !== 'tabulated') throw new Error('unreachable');
    expect(p.cAngles).toEqual([0]);
    expect(intensityAt(p, 137, 0)).toBeCloseTo(1000, 6);
  });

  it('mirrors a C0-C180 symmetric fitting into the other half', () => {
    // Isym = 2 with Mc = 4 stores planes at C0, C90, C180 (Mc/2 + 1 = 3).
    const stored = [planeFor(1000), planeFor(2000), planeFor(3000)];
    const file = parseLdt(buildLdt({ iSym: 2, mc: 4, ng: NG, stored, lumens: 1000 }));

    const p = file.photometrics.photometry;
    if (p.kind !== 'tabulated') throw new Error('unreachable');
    expect(p.cAngles).toEqual([0, 90, 180, 270]);
    expect(intensityAt(p, 0, 0)).toBeCloseTo(1000, 6);
    expect(intensityAt(p, 90, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 180, 0)).toBeCloseTo(3000, 6);
    // 270 mirrors 90.
    expect(intensityAt(p, 270, 0)).toBeCloseTo(2000, 6);
  });

  it('mirrors a doubly symmetric fitting into all four quadrants', () => {
    // Isym = 4 with Mc = 8 stores C0, C45, C90 (Mc/4 + 1 = 3).
    const stored = [planeFor(1000), planeFor(2000), planeFor(3000)];
    const file = parseLdt(buildLdt({ iSym: 4, mc: 8, ng: NG, stored, lumens: 1000 }));

    const p = file.photometrics.photometry;
    if (p.kind !== 'tabulated') throw new Error('unreachable');
    expect(intensityAt(p, 45, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 135, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 225, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 315, 0)).toBeCloseTo(2000, 6);
    expect(intensityAt(p, 90, 0)).toBeCloseTo(3000, 6);
  });

  it('steps over extra lamp sets to find the angle tables', () => {
    const file = parseLdt(
      buildLdt({ iSym: 1, mc: 4, ng: NG, stored: [planeFor(500)], lumens: 10_000, lampSets: 3 }),
    );
    expect(file.photometrics.peakCandela).toBeCloseTo(5000, 6);
  });

  it('warns that a linear luminaire is being read as a point source', () => {
    const file = parseLdt(
      buildLdt({ iSym: 1, mc: 4, ng: NG, stored: [planeFor(500)], iType: 2 }),
    );
    expect(file.warnings.join(' ')).toMatch(/linear luminaire/i);
  });

  it('rejects a file whose header is not numbers where numbers belong', () => {
    expect(() => parseLdt('not\na\nvalid\nfile\n')).toThrow(LdtParseError);
  });
});
