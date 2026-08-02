import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { integrateFlux } from '../photometry/distribution';
import { parseLdt } from '../photometry/ldt';

/**
 * The EULUMDAT reader, against **real manufacturer files**.
 *
 * Sourced from the test corpus of `123VincentB/eulumdat-py` (MIT), an
 * independent EULUMDAT implementation. Six files, chosen to cover **every**
 * symmetry case the format defines — `Isym` 0 through 4 — and all three `Ityp`
 * values, from manufacturers including Tulux and LEDiL.
 *
 * ## The check that makes this worth having
 *
 * A EULUMDAT file declares its lamp's total flux in the header, and separately
 * carries a candela table in **cd/1000 lm**. Those two are independent: the
 * header number is typed in, the table is measured. So integrating the parsed
 * table over the sphere and comparing the result to the declared flux tests
 * essentially the whole reader at once — the cd/1000 lm scaling, the C and
 * gamma angle assignment, and above all the symmetry expansion, since mirroring
 * the wrong planes changes the integral.
 *
 * It comes out right to within 0.1% on every file whose luminaire emits all of
 * its lamp's light, and on the one that does not it recovers that luminaire's
 * own stated light output ratio. That is a far stronger statement than any
 * synthetic fixture in `ldt.test.ts` can make.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string =>
  readFileSync(join(HERE, 'fixtures', name), 'latin1');

interface Case {
  file: string;
  label: string;
  iSym: number;
  /** Expected ratio of integrated flux to declared lamp flux. */
  fluxRatio: number;
}

const CASES: Case[] = [
  { file: 'ldt-isym1-point-symmetric.ldt', label: 'Isym 1 — rotationally symmetric', iSym: 1, fluxRatio: 1 },
  { file: 'ldt-isym0-asymmetric.ldt', label: 'Isym 0 — no symmetry', iSym: 0, fluxRatio: 1 },
  { file: 'ldt-isym2-c0c180.ldt', label: 'Isym 2 — mirrored about C0–C180', iSym: 2, fluxRatio: 1 },
  { file: 'ldt-isym3-c90c270.ldt', label: 'Isym 3 — mirrored about C90–C270', iSym: 3, fluxRatio: 1 },
  { file: 'ldt-isym4-quadrant.ldt', label: 'Isym 4 — mirrored in both planes', iSym: 4, fluxRatio: 1 },
];

describe('real EULUMDAT files', () => {
  it.each(CASES)('$label parses', ({ file }) => {
    const parsed = parseLdt(read(file));
    expect(parsed.photometrics.provenance).toBe('measured');
    expect(parsed.photometrics.peakCandela).toBeGreaterThan(0);
    expect(parsed.declaredLumens).toBeGreaterThan(0);
  });

  it.each(CASES)(
    '$label integrates back to the declared lamp flux',
    ({ file, fluxRatio }) => {
      const parsed = parseLdt(read(file));
      const flux = integrateFlux(parsed.photometrics.photometry);

      // 2% covers the trapezoidal integration of a coarsely sampled table;
      // a mis-mirrored symmetry case is out by tens of percent, not two.
      expect(flux / parsed.declaredLumens).toBeGreaterThan(fluxRatio - 0.02);
      expect(flux / parsed.declaredLumens).toBeLessThan(fluxRatio + 0.02);
    },
  );

  it('expands each symmetry case to a full circle of C planes', () => {
    for (const { file, iSym } of CASES) {
      const p = parseLdt(read(file)).photometrics.photometry;
      expect(p.kind).toBe('tabulated');
      if (p.kind !== 'tabulated') throw new Error('unreachable');

      if (iSym === 1) {
        // Rotationally symmetric: one plane serves every azimuth, however
        // many C angles the header lists.
        expect(p.cAngles).toEqual([0]);
      } else {
        expect(p.cAngles.length).toBeGreaterThan(1);
        expect(p.cAngles[0]).toBe(0);
        expect(p.cAngles[p.cAngles.length - 1]).toBeLessThan(360);
        expect(p.candela).toHaveLength(p.cAngles.length * p.gammaAngles.length);
      }
    }
  });

  it('recovers a luminaire’s stated light output ratio', () => {
    // A LEDiL street optic. Its header declares a 400 lm lamp, and line 23
    // declares a light output ratio of 88.63% — so the luminaire emits only
    // that fraction of the lamp, and integrating its candela table has to land
    // there rather than at 400 lm.
    //
    // This one file rules out the whole class of bug where the reader scales
    // the table to make the flux come out "right": nothing here knows about
    // the ratio, and it falls out of the measured data on its own.
    const parsed = parseLdt(read('ldt-isym0-lor-88pct.ldt'));
    const flux = integrateFlux(parsed.photometrics.photometry);

    expect(parsed.declaredLumens).toBe(400);
    expect(flux / parsed.declaredLumens).toBeGreaterThan(0.87);
    expect(flux / parsed.declaredLumens).toBeLessThan(0.90);
  });

  it('warns that a linear luminaire is being treated as a point source', () => {
    // Ityp = 2. The warning matters: these are metre-long fittings, and the
    // point-source assumption overstates levels close to them.
    const parsed = parseLdt(read('ldt-isym2-c0c180.ldt'));
    expect(parsed.warnings.join(' ')).toMatch(/linear luminaire/i);
  });
});
