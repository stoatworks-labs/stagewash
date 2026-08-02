import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { intensityAt } from '../photometry/distribution';
import { parseIes } from '../photometry/ies';
import { maxGammaOf } from '../rig';

/**
 * The parser, against **real manufacturer files**.
 *
 * Everything in `ies.test.ts` is synthetic — files built to the spec by the
 * test itself. That proves the reader matches my reading of LM-63; it cannot
 * prove it matches what a manufacturer actually ships. These three files are
 * ETC's own, from the "Source Four HPL IES Photometry Data Files (LM-63-02
 * Format)" bundle on etcconnect.com, and they exercise things no synthetic
 * fixture in this repo happened to: a candela multiplier of 96.96, 181 C planes
 * encoded as a full 0–360 sweep, keywords with no space after the bracket, and
 * candela rows wrapped mid-row at column 80.
 *
 * The whole 132-file bundle parses with zero failures and zero warnings. Three
 * are vendored here because 132 is 6 MB; point `STAGEWASH_IES_DIR` at an
 * extract of the bundle to sweep the lot.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

// ETC ships these as Windows-codepage text, and the degree signs in the
// keywords are not UTF-8. Reading as latin1 rather than utf8 keeps them from
// becoming replacement characters — the numbers parse either way, but the
// citation string in the UI would be mojibake.
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'latin1');

describe('a real ETC Source Four 36° file', () => {
  const file = parseIes(read('etc-s4-36-hpl750-115.ies'));

  it('parses without complaint', () => {
    expect(file.warnings).toEqual([]);
    expect(file.photometrics.provenance).toBe('measured');
  });

  it('reads the identifying keywords, including one with no space after the bracket', () => {
    // The file's first keyword line is literally "[TEST]#7".
    expect(file.keywords['TEST']).toBe('#7');
    expect(file.keywords['MANUFAC']).toBe('Electronic Theatre Controls, Inc.');
    expect(file.keywords['LUMCAT']).toBe('Source Four UL');
    expect(file.photometrics.source).toContain('Electronic Theatre Controls');
  });

  it('applies the candela multiplier', () => {
    // The file's multiplier is 96.96 and its tabulated on-axis values sit
    // around 1036–1064 — they vary by about 3% between C planes, which is
    // measurement scatter, so the peak is not simply the C = 0 value.
    //
    // Dividing back out has to land in that band. Missing the multiplier
    // entirely would give ~1,036 cd instead of ~100,000: a fixture 100x too
    // dim, and the single most likely way to get LM-63 wrong.
    const tabulated = file.photometrics.peakCandela / 96.96;
    expect(tabulated).toBeGreaterThan(1030);
    expect(tabulated).toBeLessThan(1070);

    expect(file.photometrics.peakCandela).toBeGreaterThan(90_000);
    expect(file.photometrics.peakCandela).toBeLessThan(110_000);
  });

  it('reads the declared lamp output', () => {
    expect(file.declaredLumens).toBe(21_900); // HPL 750/115, per the lamp table
    expect(file.watts).toBe(750);
  });

  it('recovers beam and field angles from the measured table', () => {
    // Computed by hand from the C=0 plane of this file: 50% of 1035.93 falls
    // between gamma 10 (563.24) and 12 (423.84) => 10.6°, so a 21.3° beam;
    // 10% falls between 16 (130.30) and 18 (16.69) => 16.5°, so a 32.9° field.
    expect(file.photometrics.beamAngle).toBeGreaterThan(20);
    expect(file.photometrics.beamAngle).toBeLessThan(24);
    expect(file.photometrics.fieldAngle).toBeGreaterThan(31);
    expect(file.photometrics.fieldAngle).toBeLessThan(35);
  });

  it('drops the duplicate 360° plane from the full sweep', () => {
    const p = file.photometrics.photometry;
    expect(p.kind).toBe('tabulated');
    if (p.kind !== 'tabulated') throw new Error('unreachable');

    // The file lists 181 horizontal angles, 0 to 360 in 2° steps. The 360 plane
    // repeats the 0 plane, and keeping both gives the cyclic interpolator a
    // zero-width final interval.
    expect(p.cAngles).toHaveLength(180);
    expect(p.cAngles[0]).toBe(0);
    expect(p.cAngles[179]).toBe(358);
    expect(p.gammaAngles).toHaveLength(46);
    expect(p.candela).toHaveLength(180 * 46);
  });

  it('reports a cutoff at the last live row, not the last measured one', () => {
    // The solver's early-out. This file is sampled to 90° but is all zeros
    // past about 26°, and taking 90° at face value made it evaluate the full
    // table across most of the stage for no contribution.
    const cutoff = maxGammaOf(file.photometrics.photometry);

    expect(cutoff).toBeGreaterThan(file.photometrics.fieldAngle / 2);
    expect(cutoff).toBeLessThan(45);

    // And the trim must be lossless: nothing beyond the cutoff was carrying
    // light in any C plane.
    const p = file.photometrics.photometry;
    if (p.kind !== 'tabulated') throw new Error('unreachable');
    for (const c of [0, 45, 90, 180, 270]) {
      for (let gamma = cutoff; gamma <= 90; gamma += 2) {
        expect(intensityAt(p, c, gamma)).toBe(0);
      }
    }
  });

  it('emits nothing behind itself', () => {
    const p = file.photometrics.photometry;
    // Measured to 90° only, so anything past that is off the end of the table.
    expect(intensityAt(p, 0, 91)).toBe(0);
    expect(intensityAt(p, 0, 180)).toBe(0);
    // And the last measured ring is genuinely dark, not clamped.
    expect(intensityAt(p, 0, 90)).toBeLessThan(file.photometrics.peakCandela * 0.001);
  });
});

describe('a real oval-beam file', () => {
  const file = parseIes(read('etc-s4-par-ea-mfl-hpl575-115.ies'));

  it('parses without complaint', () => {
    expect(file.warnings).toEqual([]);
  });

  it('is genuinely asymmetric about the beam axis', () => {
    // The MFL lens throws an oval. This is the case a synthetic rotationally
    // symmetric fixture cannot exercise: if C were being ignored, or the
    // candela block were being indexed [gamma][C] instead of [C][gamma], the
    // two axes would come out identical.
    const p = file.photometrics.photometry;
    const peak = file.photometrics.peakCandela;

    const alongC0: number[] = [];
    const alongC90: number[] = [];
    for (let gamma = 0; gamma <= 20; gamma += 2) {
      alongC0.push(intensityAt(p, 0, gamma));
      alongC90.push(intensityAt(p, 90, gamma));
    }

    expect(alongC0[0]).toBeCloseTo(peak, -1);
    expect(alongC90[0]).toBeCloseTo(peak, -1);

    // Somewhere off axis the two planes must diverge substantially.
    const biggestRatio = alongC0.reduce((worst, v, i) => {
      const other = alongC90[i] as number;
      if (v < peak * 0.02 && other < peak * 0.02) return worst;
      const ratio = Math.max(v, other) / Math.max(Math.min(v, other), 1);
      return Math.max(worst, ratio);
    }, 1);

    expect(biggestRatio).toBeGreaterThan(1.5);
  });
});

describe('a real wide-beam file', () => {
  const file = parseIes(read('etc-s4-parnel-flood-hpl750-115.ies'));

  it('parses without complaint', () => {
    expect(file.warnings).toEqual([]);
  });

  it('agrees with the published datasheet figures', () => {
    // ETC's PARNel datasheet quotes 47,050 cd and a 47° field for this
    // fixture; the file gives 47,028 cd and 47.0°. Better than 0.1% on both,
    // which is about as strong a check on the reader as exists.
    expect(file.photometrics.peakCandela).toBeGreaterThan(46_000);
    expect(file.photometrics.peakCandela).toBeLessThan(48_000);
    expect(file.photometrics.fieldAngle).toBeGreaterThan(45);
    expect(file.photometrics.fieldAngle).toBeLessThan(49);
  });
});

describe('the whole ETC bundle, when it is available', () => {
  /**
   * Opt-in sweep. Extract the ETC bundle anywhere and run:
   *
   *   STAGEWASH_IES_DIR=/path/to/extract npx vitest run iesReal
   *
   * Skipped otherwise, so the suite does not depend on a 6 MB download.
   */
  const dir = process.env['STAGEWASH_IES_DIR'];

  it.skipIf(!dir)('parses every file in it', () => {
    const files = walk(dir as string);
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const path of files) {
      try {
        const parsed = parseIes(readFileSync(path, 'latin1'));
        const p = parsed.photometrics;
        if (!(p.peakCandela > 0) || !(p.fieldAngle > 0) || !(p.outputLumens > 0)) {
          failures.push(`${path}: implausible values`);
        }
        for (const warning of parsed.warnings) failures.push(`${path}: ${warning}`);
      } catch (cause) {
        failures.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ies$/i.test(name)) out.push(full);
  }
  return out;
}
