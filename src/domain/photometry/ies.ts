/**
 * IESNA LM-63 photometric file reader.
 *
 * Handles LM-63-1986, -1991, -1995 and -2002, which differ mainly in the header
 * line and the keyword block — the numeric payload has been stable throughout.
 *
 * ## Layout
 *
 * ```
 * IESNA:LM-63-2002              <- absent in the 1986 format
 * [TEST] ...                    <- keyword block, any number of lines
 * [MANUFAC] ...
 * TILT=NONE                     <- or TILT=INCLUDE, or TILT=<filename>
 * <lamps> <lumens/lamp> <multiplier> <nVert> <nHoriz> <type> <units> <w> <l> <h>
 * <ballast factor> <ballast-lamp factor> <input watts>
 * <nVert vertical angles>
 * <nHoriz horizontal angles>
 * <nHoriz × nVert candela values>
 * ```
 *
 * The numeric section is **free-form whitespace**: a file may put all ten
 * header values on one line or spread them over four, and candela values wrap
 * wherever the writer felt like it. So everything after the TILT line is
 * tokenised into one flat number stream and consumed in order. Parsing line by
 * line is the single most common way to get this format wrong.
 *
 * ## Angles
 *
 * For photometric **Type C** — which is what every entertainment fixture is
 * measured in — the vertical angle is measured from nadir, and the fixture is
 * measured with its beam pointing at nadir. So the file's vertical angle *is*
 * our gamma, with no transformation. Types A and B (used for floodlights and
 * roadway optics) use a different pair of axes; they are detected and rejected
 * rather than silently misread, because a Type B file read as Type C produces a
 * distribution that looks plausible and is wrong.
 */

import type { FixturePhotometrics, TabulatedPhotometry } from '../types';
import {
  angleAtFraction,
  integrateFlux,
  peakCandela,
  withUniformSteps,
} from './distribution';

export interface IesFile {
  photometrics: FixturePhotometrics;
  keywords: Record<string, string>;
  /** Declared lamp lumens per lamp × lamp count. -1 in the file means absolute. */
  declaredLumens: number;
  /** Watts as declared in the file. */
  watts: number;
  /** Luminous opening, metres. */
  dimensions: { width: number; length: number; height: number };
  /** Anything the file did that the reader had to paper over. */
  warnings: string[];
}

export class IesParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IesParseError';
  }
}

const PHOTOMETRIC_TYPE_NAMES: Record<number, string> = {
  1: 'Type C',
  2: 'Type B',
  3: 'Type A',
};

export function parseIes(text: string): IesFile {
  const warnings: string[] = [];
  // Files come off Windows tools and out of zips; both line endings occur, and
  // a UTF-8 BOM on the first line stops the format sniff from matching.
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');

  const keywords: Record<string, string> = {};
  let tiltIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (/^TILT\s*=/i.test(line)) {
      tiltIndex = i;
      break;
    }
    const kw = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (kw) {
      const key = (kw[1] as string).toUpperCase();
      const value = (kw[2] as string).trim();
      keywords[key] = keywords[key] ? `${keywords[key]} ${value}` : value;
    }
  }

  if (tiltIndex < 0) {
    throw new IesParseError(
      'No TILT= line found. This does not look like an IESNA LM-63 file.',
    );
  }

  const tiltValue = ((lines[tiltIndex] as string).split('=')[1] ?? '').trim().toUpperCase();
  let cursor = tiltIndex + 1;

  if (tiltValue === 'INCLUDE') {
    // The embedded tilt block is: lamp-to-luminaire geometry, then a pair
    // count, then that many angles followed by that many multipliers. It
    // describes how output changes as the luminaire is tilted during
    // *measurement* — irrelevant to us, but it has to be stepped over or its
    // numbers get consumed as the header.
    const tiltTokens = numbersFrom(lines.slice(cursor));
    const pairCount = Math.round(tiltTokens[1] ?? 0);
    const consumed = 2 + pairCount * 2;
    cursor = advanceLines(lines, cursor, consumed);
    warnings.push('File carries an embedded TILT block; it was skipped.');
  } else if (tiltValue !== 'NONE') {
    warnings.push(
      `File references an external tilt file (${tiltValue}), which is not available. Tilt correction was not applied.`,
    );
  }

  const t = numbersFrom(lines.slice(cursor));
  let p = 0;
  const next = (what: string): number => {
    const v = t[p++];
    if (v === undefined || !Number.isFinite(v)) {
      throw new IesParseError(`File ended while reading ${what}.`);
    }
    return v;
  };

  const lampCount = next('lamp count');
  const lumensPerLamp = next('lumens per lamp');
  const candelaMultiplier = next('candela multiplier');
  const nVert = Math.round(next('vertical angle count'));
  const nHoriz = Math.round(next('horizontal angle count'));
  const photometricType = Math.round(next('photometric type'));
  const unitsType = Math.round(next('units type'));
  const width = next('luminous width');
  const lengthDim = next('luminous length');
  const heightDim = next('luminous height');
  const ballastFactor = next('ballast factor');
  const futureFactor = next('ballast-lamp photometric factor');
  const watts = next('input watts');

  if (photometricType !== 1) {
    throw new IesParseError(
      `Photometric ${PHOTOMETRIC_TYPE_NAMES[photometricType] ?? photometricType} is not supported — only Type C is. Type A and B files measure their angles from different axes, and reading one as Type C gives a wrong answer that looks right.`,
    );
  }
  if (nVert < 2 || nHoriz < 1) {
    throw new IesParseError(
      `Implausible angle counts in the header (${nVert} vertical, ${nHoriz} horizontal).`,
    );
  }

  const verticalAngles: number[] = [];
  for (let i = 0; i < nVert; i++) verticalAngles.push(next('vertical angles'));
  const horizontalAngles: number[] = [];
  for (let i = 0; i < nHoriz; i++) horizontalAngles.push(next('horizontal angles'));

  // The spec says the final candela is the tabulated value times all three
  // factors. Files in the wild sometimes carry 0 in one of them, which would
  // zero the whole fixture; treat a non-positive factor as 1 and say so.
  const factors = [candelaMultiplier, ballastFactor, futureFactor];
  const names = ['candela multiplier', 'ballast factor', 'ballast-lamp factor'];
  let multiplier = 1;
  factors.forEach((f, i) => {
    if (f > 0) multiplier *= f;
    else warnings.push(`${names[i]} was ${f}; treated as 1.`);
  });

  const raw: number[] = new Array(nHoriz * nVert);
  for (let h = 0; h < nHoriz; h++) {
    for (let v = 0; v < nVert; v++) {
      raw[h * nVert + v] = next('candela values') * multiplier;
    }
  }

  if (!ascending(verticalAngles)) {
    throw new IesParseError('Vertical angles are not in ascending order.');
  }

  const { cAngles, candela } = expandSymmetry(
    horizontalAngles,
    raw,
    nVert,
    warnings,
  );

  const photometry: TabulatedPhotometry = withUniformSteps({
    kind: 'tabulated',
    gammaAngles: verticalAngles,
    cAngles,
    candela,
  });

  const declaredLumens = lumensPerLamp < 0 ? -1 : lumensPerLamp * lampCount;
  if (lumensPerLamp < 0) {
    // -1 is the spec's flag for "these are absolute candela, not per-lamp".
    // Common for LED fixtures. Nothing to do but note it.
    warnings.push('File declares absolute photometry (lumens per lamp = -1).');
  }

  const toMetres = unitsType === 1 ? 0.3048 : 1;

  const integrated = integrateFlux(photometry);
  if (declaredLumens > 0) {
    const ratio = integrated / declaredLumens;
    // A file whose integrated flux exceeds the lamp that produced it is
    // impossible, and a file that integrates to a tiny fraction has usually
    // been read with the wrong multiplier. Neither is fatal — the candela
    // table is still what we use — but both are worth surfacing.
    if (ratio > 1.05 || ratio < 0.05) {
      warnings.push(
        `Integrated flux (${Math.round(integrated).toLocaleString()} lm) is ${ratio > 1 ? 'more than' : 'far below'} the declared lamp output (${Math.round(declaredLumens).toLocaleString()} lm). The candela table is used as-is; check the file.`,
      );
    }
  }

  return {
    photometrics: {
      photometry,
      outputLumens: integrated,
      beamAngle: angleAtFraction(photometry, 0.5),
      fieldAngle: angleAtFraction(photometry, 0.1),
      peakCandela: peakCandela(photometry),
      provenance: 'measured',
      source: describeSource(keywords),
    },
    keywords,
    declaredLumens,
    watts,
    dimensions: {
      width: Math.abs(width) * toMetres,
      length: Math.abs(lengthDim) * toMetres,
      height: Math.abs(heightDim) * toMetres,
    },
    warnings,
  };
}

/**
 * Turn the file's C planes into an explicit 0..<360 set.
 *
 * LM-63 encodes symmetry by how far the horizontal angles run:
 *
 * | last angle | meaning                                  |
 * |------------|------------------------------------------|
 * | 0          | rotationally symmetric, one plane        |
 * | 90         | symmetric in each quadrant               |
 * | 180        | symmetric about the 0–180 plane          |
 * | 360        | fully asymmetric (360 repeats 0)         |
 *
 * Expanding here rather than at sample time means the interpolator has one
 * simple job and asymmetric fixtures cannot be quietly mishandled on the hot
 * path.
 */
function expandSymmetry(
  horizontalAngles: number[],
  raw: number[],
  nVert: number,
  warnings: string[],
): { cAngles: number[]; candela: number[] } {
  const n = horizontalAngles.length;
  const last = horizontalAngles[n - 1] as number;

  if (n === 1) return { cAngles: [horizontalAngles[0] as number], candela: raw };

  const planeAt = (index: number): number[] => raw.slice(index * nVert, (index + 1) * nVert);

  if (Math.abs(last - 360) < 1e-6) {
    // The 360 plane is the 0 plane again; keeping both makes the cyclic
    // interpolator see a zero-width final interval.
    return {
      cAngles: horizontalAngles.slice(0, n - 1),
      candela: raw.slice(0, (n - 1) * nVert),
    };
  }

  const source = new Map<number, number[]>();
  horizontalAngles.forEach((a, i) => source.set(round(a), planeAt(i)));

  const fold = (c: number): number => {
    if (Math.abs(last - 90) < 1e-6) {
      const q = ((c % 360) + 360) % 360;
      if (q <= 90) return q;
      if (q <= 180) return 180 - q;
      if (q <= 270) return q - 180;
      return 360 - q;
    }
    if (Math.abs(last - 180) < 1e-6) {
      const q = ((c % 360) + 360) % 360;
      return q <= 180 ? q : 360 - q;
    }
    return ((c % 360) + 360) % 360;
  };

  if (Math.abs(last - 90) > 1e-6 && Math.abs(last - 180) > 1e-6) {
    warnings.push(
      `Horizontal angles end at ${last}°, which is not one of the symmetries LM-63 defines (0, 90, 180, 360). Treated as measured planes with no mirroring.`,
    );
    return { cAngles: horizontalAngles, candela: raw };
  }

  // Rebuild a full circle at the file's own angular resolution.
  const step = Math.abs((horizontalAngles[1] as number) - (horizontalAngles[0] as number)) || 90;
  const cAngles: number[] = [];
  const candela: number[] = [];
  for (let c = 0; c < 360 - 1e-9; c += step) {
    const plane = source.get(round(fold(c)));
    if (!plane) {
      // The fold landed between measured planes — possible when the file's
      // angles are unevenly spaced. Fall back to the nearest measured plane
      // rather than dropping the whole ring.
      const folded = fold(c);
      let best = horizontalAngles[0] as number;
      for (const a of horizontalAngles) {
        if (Math.abs(a - folded) < Math.abs(best - folded)) best = a;
      }
      cAngles.push(c);
      candela.push(...(source.get(round(best)) as number[]));
      continue;
    }
    cAngles.push(c);
    candela.push(...plane);
  }

  return { cAngles, candela };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

function ascending(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if ((xs[i] as number) < (xs[i - 1] as number)) return false;
  }
  return true;
}

/** Pull every whitespace-separated number out of a block of lines, in order. */
function numbersFrom(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    for (const tok of line.split(/[\s,]+/)) {
      if (tok === '') continue;
      const v = Number(tok);
      if (Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

/** Step `cursor` forward past `count` numbers, returning the new line index. */
function advanceLines(lines: string[], cursor: number, count: number): number {
  let seen = 0;
  let i = cursor;
  while (i < lines.length && seen < count) {
    for (const tok of (lines[i] as string).split(/[\s,]+/)) {
      if (tok !== '' && Number.isFinite(Number(tok))) seen++;
    }
    i++;
  }
  return i;
}

function describeSource(keywords: Record<string, string>): string {
  const parts = [
    keywords['MANUFAC'],
    keywords['LUMCAT'],
    keywords['LUMINAIRE'],
    keywords['TEST'] ? `test ${keywords['TEST']}` : undefined,
    keywords['ISSUEDATE'] ?? keywords['TESTDATE'],
  ].filter((s): s is string => Boolean(s && s.trim()));

  return parts.length > 0
    ? `IES photometric file — ${parts.join(', ')}`
    : 'IES photometric file (no identifying keywords)';
}
