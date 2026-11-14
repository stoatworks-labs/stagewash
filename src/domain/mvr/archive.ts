/**
 * The `.mvr` container: a zip with `GeneralSceneDescription.xml` at its root
 * and every referenced file beside it. A `.gdtf` inside it is itself a zip
 * with a `description.xml`.
 *
 * Pure byte-in, byte-out — no File, no Blob — so the same code runs in the
 * browser and in the test suite.
 *
 * Only the scene and the GDTF descriptions are ever inflated. A real MVR is
 * mostly 3D models (the Capture demo show is 2.7 MB, of which the XML and the
 * fixture types are about 300 kB), and stagewash has no use for meshes.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

import { parseGdtfDescription, type GdtfSummary } from './gdtf';
import { MvrParseError } from './scene';

export const SCENE_FILE = 'GeneralSceneDescription.xml';

export interface MvrArchive {
  sceneXml: string;
  /** Parsed GDTF fixture types, keyed by file name as it appears in the archive. */
  gdtf: Map<string, GdtfSummary>;
  /** GDTF files that were present but could not be read, with the reason. */
  gdtfErrors: Map<string, string>;
}

const isGdtf = (name: string): boolean => /\.gdtf$/i.test(name) && !name.includes('/');

export function readMvrArchive(bytes: Uint8Array): MvrArchive {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => file.name.toLowerCase() === SCENE_FILE.toLowerCase() || isGdtf(file.name),
    });
  } catch (cause) {
    throw new MvrParseError(
      `Not a readable MVR file (it should be a zip archive): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const sceneName = Object.keys(entries).find(
    (name) => name.toLowerCase() === SCENE_FILE.toLowerCase(),
  );
  if (!sceneName) {
    throw new MvrParseError(`The archive has no ${SCENE_FILE}, so it is not an MVR file.`);
  }

  const gdtf = new Map<string, GdtfSummary>();
  const gdtfErrors = new Map<string, string>();
  for (const [name, data] of Object.entries(entries)) {
    if (!isGdtf(name)) continue;
    try {
      const inner = unzipSync(data, { filter: (file) => file.name === 'description.xml' });
      const description = inner['description.xml'];
      if (!description) throw new Error('no description.xml inside');
      gdtf.set(name, parseGdtfDescription(strFromU8(description)));
    } catch (cause) {
      gdtfErrors.set(name, cause instanceof Error ? cause.message : String(cause));
    }
  }

  return { sceneXml: strFromU8(entries[sceneName] as Uint8Array), gdtf, gdtfErrors };
}

/**
 * Find the GDTF a fixture's `GDTFSpec` refers to.
 *
 * The spec says `GDTFSpec` is a file name with its extension. Vectorworks
 * writes it without one — `Custom@Light Instr Light Source Pendant 44deg` for
 * a file stored as `…44deg.gdtf` — so try the name as written, then with
 * `.gdtf`, then ignoring case.
 */
export function findGdtf(archive: MvrArchive, spec: string): { file: string; summary: GdtfSummary } | undefined {
  const wanted = spec.trim();
  if (!wanted) return undefined;
  for (const candidate of [wanted, `${wanted}.gdtf`]) {
    const hit = archive.gdtf.get(candidate);
    if (hit) return { file: candidate, summary: hit };
  }
  const lower = wanted.toLowerCase();
  for (const [file, summary] of archive.gdtf) {
    const f = file.toLowerCase();
    if (f === lower || f === `${lower}.gdtf`) return { file, summary };
  }
  return undefined;
}

/** Zip a set of files into an `.mvr`. Text is written as UTF-8, as the spec requires. */
export function writeMvrArchive(files: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) {
    zippable[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  // DEFLATE is one of the two methods the spec allows (STORE is the other).
  return zipSync(zippable, { level: 6 });
}
