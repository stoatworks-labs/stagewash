/**
 * EULUMDAT (.ldt) photometric file reader.
 *
 * The European counterpart to IES. Strictly one value per line, no keywords, no
 * delimiters — position in the file *is* the schema, which makes it easy to
 * read and unforgiving of a file that is one line out.
 *
 * Entertainment manufacturers mostly ship IES; EULUMDAT turns up on
 * architectural and house-light fittings, and on European floodlights. It is
 * supported so that a venue's own house rig can be modelled from the fittings'
 * own data.
 *
 * ## Layout
 *
 * Lines 1–26 are a fixed header, then `n` lamp sets of 6 lines each, then 10
 * direct-ratio values, then the C angles, the gamma angles, and the intensity
 * table.
 *
 * ## The two traps
 *
 * 1. **Intensities are in cd/1000 lm**, not candela. They must be scaled by the
 *    lamp set's total flux ÷ 1000. A reader that skips this is out by whatever
 *    the lamp happens to be — typically a factor of 10 to 30, which looks like
 *    a unit error somewhere else entirely.
 * 2. **How many C planes are stored depends on `Isym`.** The C *angle* list is
 *    always `Mc` long, but the *intensity* table only carries `Mc2` planes,
 *    with the rest implied by mirroring. Reading `Mc` planes of intensities
 *    runs off the end of the file for any symmetric fitting, which is most of
 *    them.
 */

import type { FixturePhotometrics, TabulatedPhotometry } from '../types';
import { angleAtFraction, integrateFlux, peakCandela } from './distribution';

export interface LdtFile {
  photometrics: FixturePhotometrics;
  company: string;
  luminaireName: string;
  luminaireNumber: string;
  /** Total lamp flux of the first lamp set, lumens. */
  declaredLumens: number;
  watts: number;
  warnings: string[];
}

export class LdtParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LdtParseError';
  }
}

/** Symmetry indicator (`Isym`, line 3). */
const SYM_NONE = 0;
const SYM_VERTICAL_AXIS = 1;
const SYM_C0_C180 = 2;
const SYM_C90_C270 = 3;
const SYM_BOTH = 4;

export function parseLdt(text: string): LdtFile {
  const warnings: string[] = [];
  const lines = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim());

  const at = (index: number): string => lines[index] ?? '';
  const num = (index: number, what: string): number => {
    const v = Number(at(index).replace(',', '.'));
    if (!Number.isFinite(v)) {
      throw new LdtParseError(`Line ${index + 1} should be ${what} but reads "${at(index)}".`);
    }
    return v;
  };

  const company = at(0);
  const iType = num(1, 'the type indicator (Ityp)');
  const iSym = num(2, 'the symmetry indicator (Isym)');
  const mc = Math.round(num(3, 'the number of C planes (Mc)'));
  const ng = Math.round(num(5, 'the number of gamma angles (Ng)'));
  const luminaireName = at(8);
  const luminaireNumber = at(9);
  const conversionFactor = num(23, 'the intensity conversion factor');
  const lampSetCount = Math.round(num(25, 'the number of lamp sets'));

  if (mc < 1 || ng < 2) {
    throw new LdtParseError(`Implausible angle counts (Mc = ${mc}, Ng = ${ng}).`);
  }
  if (iType === 2) {
    warnings.push(
      'File describes a linear luminaire (Ityp = 2). Its photometry is read as a point source, which overstates levels close to the fitting.',
    );
  }

  // Lamp sets: 6 lines each from line 27 (index 26). Only the first is used —
  // the others are alternative lamps for the same optic.
  const lampBase = 26;
  if (lampSetCount < 1) {
    throw new LdtParseError('File declares no lamp sets.');
  }
  const declaredLumens = Number(at(lampBase + 2).replace(',', '.'));
  const watts = Number(at(lampBase + 5).replace(',', '.'));

  // 10 direct ratios follow the lamp sets, then the angle tables.
  const afterLamps = lampBase + lampSetCount * 6;
  let cursor = afterLamps + 10;

  const cAnglesRaw: number[] = [];
  for (let i = 0; i < mc; i++) cAnglesRaw.push(num(cursor++, 'a C angle'));

  const gammaAngles: number[] = [];
  for (let i = 0; i < ng; i++) gammaAngles.push(num(cursor++, 'a gamma angle'));

  const storedPlanes = storedPlaneCount(iSym, mc);
  const stored: number[][] = [];
  for (let m = 0; m < storedPlanes; m++) {
    const plane: number[] = [];
    for (let g = 0; g < ng; g++) plane.push(num(cursor++, 'an intensity value'));
    stored.push(plane);
  }

  // cd/1000 lm → cd. `conversionFactor` is usually 1; it exists for files that
  // are already absolute.
  const flux = Number.isFinite(declaredLumens) && declaredLumens > 0 ? declaredLumens : 1000;
  const scale = (flux / 1000) * (Number.isFinite(conversionFactor) && conversionFactor > 0 ? conversionFactor : 1);
  if (!Number.isFinite(declaredLumens) || declaredLumens <= 0) {
    warnings.push(
      'No usable lamp flux in the file, so intensities are left in cd/1000 lm. Absolute levels from this fixture are not meaningful until you set its output.',
    );
  }

  const { cAngles, candela } = expandSymmetry(iSym, mc, cAnglesRaw, stored, ng, scale, warnings);

  const photometry: TabulatedPhotometry = { kind: 'tabulated', gammaAngles, cAngles, candela };

  return {
    photometrics: {
      photometry,
      outputLumens: integrateFlux(photometry),
      beamAngle: angleAtFraction(photometry, 0.5),
      fieldAngle: angleAtFraction(photometry, 0.1),
      peakCandela: peakCandela(photometry),
      provenance: 'measured',
      source: `EULUMDAT file — ${[company, luminaireName, luminaireNumber].filter(Boolean).join(', ') || 'unidentified'}`,
    },
    company,
    luminaireName,
    luminaireNumber,
    declaredLumens: flux,
    watts,
    warnings,
  };
}

/** How many C planes of intensity data the file actually stores. */
function storedPlaneCount(iSym: number, mc: number): number {
  switch (iSym) {
    case SYM_VERTICAL_AXIS:
      return 1;
    case SYM_C0_C180:
    case SYM_C90_C270:
      return Math.round(mc / 2) + 1;
    case SYM_BOTH:
      return Math.round(mc / 4) + 1;
    case SYM_NONE:
    default:
      return mc;
  }
}

/**
 * Mirror the stored planes out to a full circle, matching what `Isym` claims.
 *
 * `Isym = 3` is the awkward one: its stored planes run from C90 to C270 rather
 * than from C0, so the index has to be offset before mirroring or the whole
 * distribution comes out rotated 90°.
 */
function expandSymmetry(
  iSym: number,
  mc: number,
  cAnglesRaw: number[],
  stored: number[][],
  ng: number,
  scale: number,
  warnings: string[],
): { cAngles: number[]; candela: number[] } {
  const scalePlane = (plane: number[]): number[] => plane.map((v) => v * scale);

  if (iSym === SYM_VERTICAL_AXIS) {
    return { cAngles: [0], candela: scalePlane(stored[0] ?? new Array(ng).fill(0)) };
  }

  if (iSym === SYM_NONE) {
    const cAngles = cAnglesRaw.slice(0, stored.length);
    const candela: number[] = [];
    for (const plane of stored) candela.push(...scalePlane(plane));
    return { cAngles, candela };
  }

  const step = mc > 0 ? 360 / mc : 90;
  const cAngles: number[] = [];
  const candela: number[] = [];

  for (let i = 0; i < mc; i++) {
    const c = i * step;
    let sourceIndex: number;

    if (iSym === SYM_C0_C180) {
      // Stored 0..180; 180..360 mirrors back.
      const half = Math.round(mc / 2);
      sourceIndex = i <= half ? i : mc - i;
    } else if (iSym === SYM_C90_C270) {
      // Stored 90..270. Map C onto that range, then index from its start.
      const quarter = Math.round(mc / 4);
      const folded = i >= quarter ? i - quarter : i + mc - quarter;
      const half = Math.round(mc / 2);
      sourceIndex = folded <= half ? folded : mc - folded;
    } else {
      // SYM_BOTH: stored 0..90, mirrored into all four quadrants.
      const quarter = Math.round(mc / 4);
      const half = Math.round(mc / 2);
      const threeQuarter = Math.round((3 * mc) / 4);
      if (i <= quarter) sourceIndex = i;
      else if (i <= half) sourceIndex = half - i;
      else if (i <= threeQuarter) sourceIndex = i - half;
      else sourceIndex = mc - i;
    }

    const plane = stored[Math.abs(sourceIndex)] ?? stored[0];
    if (!plane) {
      warnings.push(`C plane ${c}° had no data and was filled with zero.`);
      cAngles.push(c);
      candela.push(...new Array(ng).fill(0));
      continue;
    }
    cAngles.push(c);
    candela.push(...scalePlane(plane));
  }

  return { cAngles, candela };
}
