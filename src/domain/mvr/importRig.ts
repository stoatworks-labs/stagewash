/**
 * An MVR scene as a stagewash rig.
 *
 * Three problems, in order of how much they matter:
 *
 * 1. **An MVR carries no photometry.** A fixture names a GDTF type, and a GDTF
 *    at best gives a beam angle, a field angle and a flux — often the format's
 *    placeholder defaults, sometimes nothing at all (see `gdtf.ts`). So every
 *    fixture *type* in the file is mapped to something stagewash can solve: a
 *    library model, an estimate from the GDTF's beam figures (badged
 *    `estimated`, never anything better), or nothing, in which case those
 *    fixtures are left out and the user is told. Nothing is matched by
 *    guessing at names.
 * 2. **Stagewash hangs every fixture on a structure.** A fixture's position is
 *    re-derived from its structure on every edit, so an imported fixture has
 *    to sit on a run that passes through it or it would jump. Fixtures are
 *    grouped by hanging position (or, failing that, the truss, group or layer
 *    they are in) and each group is split into straight runs; each run becomes
 *    a structure. See `splitIntoRuns`.
 * 3. **Where it points.** A focus point is an aim. Otherwise the beam is the
 *    fixture's local −Z (GDTF hangs every fixture beam-down), which becomes a
 *    pan and tilt.
 *
 * The position imported is the MVR insertion point — for a hung fixture, its
 * clamp, not its lens. That is the same simplification stagewash already
 * makes when a fixture is hung by hand (it sits on the bar's centre line), and
 * moving it to the lens on import would make it drift down a little on every
 * round trip through another tool.
 */

import {
  dot,
  fixtureFrame,
  length,
  normalise,
  panTiltFromDirection,
  scale,
  sub,
  vec,
  add,
} from '../geometry';
import { findOptic } from '../rig';
import { estimatePhotometrics } from '../photometry/estimator';
import type {
  FixtureKind,
  FixtureModel,
  Project,
  RigFixture,
  Structure,
  StructureKind,
  Vec3,
} from '../types';
import { MOVING_KINDS } from '../types';
import { findGdtf, readMvrArchive, type MvrArchive } from './archive';
import { STAGEWASH_PROVIDER, type StagewashUserData } from './exportRig';
import type { GdtfBeam, GdtfSummary } from './gdtf';
import { originM, rotate } from './matrix';
import { parseScene, type MvrFixture, type MvrScene } from './scene';
import { uuidV5 } from './uuid';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One distinct fixture type in the file, with what is known about it. */
export interface MvrFixtureType {
  /** Grouping key: the `GDTFSpec` without `.gdtf`, or the fixture name when there is none. */
  key: string;
  label: string;
  gdtfSpec: string;
  count: number;
  /** The GDTF, when the archive carried it. */
  gdtf?: { file: string; summary: GdtfSummary };
  /** Why the GDTF's beam cannot be used, when it cannot. */
  gdtfBeamProblem?: string;
}

export interface MvrDocument {
  scene: MvrScene;
  archive: MvrArchive;
  types: MvrFixtureType[];
  /** Index into `types` for each fixture in `scene.fixtures`. */
  typeOf: Map<string, string>;
  /** stagewash's own block, when the file came from stagewash and survived the trip. */
  stagewash?: StagewashUserData;
  /** Fixtures that are not lights in their own right — multipatch cells, attachments. */
  ignored: { uuid: string; reason: string }[];
}

const typeKeyOf = (f: MvrFixture): string => {
  const spec = f.gdtfSpec.trim().replace(/\.gdtf$/i, '');
  if (spec) return spec;
  return f.name.trim() ? `name:${f.name.trim()}` : 'unknown';
};

const labelFromSpec = (spec: string): string =>
  spec
    .replace(/\.gdtf$/i, '')
    .split('@')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' · ');

/** Why a GDTF beam cannot stand in for photometry, or undefined if it can. */
export function gdtfBeamProblem(summary: GdtfSummary): string | undefined {
  const beam = summary.beams[0];
  if (!beam) return 'Its GDTF has no beam geometry, so it says nothing about the light.';
  if (beam.placeholder) {
    return 'Its GDTF carries the format’s default beam (25° beam, 25° field, 10,000 lm), not real figures.';
  }
  if (!(beam.luminousFlux > 0)) return 'Its GDTF gives no luminous flux.';
  if (!(beam.fieldAngle > 0) && !(beam.beamAngle > 0)) return 'Its GDTF gives no beam or field angle.';
  return undefined;
}

export function readMvr(bytes: Uint8Array): MvrDocument {
  const archive = readMvrArchive(bytes);
  const scene = parseScene(archive.sceneXml);

  const ignored: MvrDocument['ignored'] = [];
  const typeOf = new Map<string, string>();
  const byKey = new Map<string, MvrFixtureType>();

  for (const f of scene.fixtures) {
    if (f.multipatch) {
      ignored.push({ uuid: f.uuid, reason: 'a cell of a multipatch fixture' });
      continue;
    }
    if (f.parent?.kind === 'Fixture') {
      ignored.push({ uuid: f.uuid, reason: 'an attachment to another fixture' });
      continue;
    }
    const key = typeKeyOf(f);
    typeOf.set(f.uuid, key);
    let type = byKey.get(key);
    if (!type) {
      const gdtf = findGdtf(archive, f.gdtfSpec);
      const label = gdtf
        ? [gdtf.summary.manufacturer, gdtf.summary.name].filter(Boolean).join(' ')
        : key.startsWith('name:')
          ? key.slice(5)
          : labelFromSpec(key);
      type = {
        key,
        label: label || key,
        gdtfSpec: f.gdtfSpec,
        count: 0,
        ...(gdtf ? { gdtf } : {}),
      };
      if (gdtf) {
        const problem = gdtfBeamProblem(gdtf.summary);
        if (problem) type.gdtfBeamProblem = problem;
      }
      byKey.set(key, type);
    }
    type.count++;
  }

  const stagewash = readStagewashData(scene);
  return {
    scene,
    archive,
    types: [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    typeOf,
    ...(stagewash ? { stagewash } : {}),
    ignored,
  };
}

function readStagewashData(scene: MvrScene): StagewashUserData | undefined {
  const block = scene.userData.find((d) => d.provider === STAGEWASH_PROVIDER);
  if (!block) return undefined;
  try {
    const parsed = JSON.parse(block.text) as StagewashUserData;
    if (parsed.format !== 'stagewash-mvr' || parsed.version !== 1) return undefined;
    return parsed;
  } catch {
    // A corrupt block is as good as no block: the rig still imports from the
    // standard MVR data, just without stagewash's extras.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Choosing photometry
// ---------------------------------------------------------------------------

export type TypeChoice =
  | { kind: 'model'; modelId: string; opticId: string }
  | { kind: 'gdtf' }
  | { kind: 'skip' };

/**
 * What to pre-select for each type.
 *
 * Only two things are trusted enough to choose without asking: a GDTF with a
 * real beam (badged `estimated` once imported), and a type stagewash itself
 * exported (whose `UserData` says which model it was). Everything else starts
 * unmapped. A plausible-looking guess from a fixture's name would put a
 * confident number on the screen for a light nobody identified.
 */
export function suggestChoices(
  doc: MvrDocument,
  models: Map<string, FixtureModel>,
): Map<string, TypeChoice> {
  const choices = new Map<string, TypeChoice>();
  const fromStagewash = new Map<string, { modelId: string; opticId: string }>();
  if (doc.stagewash) {
    for (const f of doc.scene.fixtures) {
      const saved = doc.stagewash.fixtures[f.uuid];
      const key = doc.typeOf.get(f.uuid);
      if (saved && key && !fromStagewash.has(key) && resolveModel(saved.modelId, models, doc)) {
        fromStagewash.set(key, { modelId: saved.modelId, opticId: saved.opticId });
      }
    }
  }
  for (const type of doc.types) {
    const saved = fromStagewash.get(type.key);
    if (saved) choices.set(type.key, { kind: 'model', ...saved });
    else if (type.gdtf && !type.gdtfBeamProblem) choices.set(type.key, { kind: 'gdtf' });
    else choices.set(type.key, { kind: 'skip' });
  }
  return choices;
}

function resolveModel(
  modelId: string,
  models: Map<string, FixtureModel>,
  doc: MvrDocument,
): FixtureModel | undefined {
  return models.get(modelId) ?? doc.stagewash?.customModels.find((m) => m.id === modelId);
}

/** Guess a stagewash kind from a GDTF. Affects which defaults the UI offers, not the maths. */
function kindFromGdtf(summary: GdtfSummary, beam: GdtfBeam): FixtureKind {
  const moving = summary.hasPanTilt;
  switch (beam.beamType) {
    case 'Spot':
      return moving ? 'movingSpot' : 'profile';
    case 'PC':
      return 'pc';
    case 'Fresnel':
      return 'fresnel';
    case 'Rectangle':
      return 'batten';
    default:
      return moving ? 'movingWash' : 'wash';
  }
}

/**
 * A custom fixture model synthesised from a GDTF beam. `estimated`, always.
 *
 * GDTF's `LuminousFlux` is "the intensity of all the represented light
 * emitters" — the fixture's output — so it is taken as lumens at the lens,
 * over the whole sphere, as an LED datasheet's figure would be. Where the file
 * gives a field angle no wider than its beam angle, which no real optic has,
 * the larger is taken as the field and the beam filled in from the kind's
 * typical ratio, and the source string says so.
 */
export function modelFromGdtf(type: MvrFixtureType): FixtureModel | undefined {
  const gdtf = type.gdtf;
  const beam = gdtf?.summary.beams[0];
  if (!gdtf || !beam || type.gdtfBeamProblem) return undefined;

  const kind = kindFromGdtf(gdtf.summary, beam);
  const notes: string[] = [];
  let fieldAngle = beam.fieldAngle;
  let beamAngle: number | undefined = beam.beamAngle;
  if (!(fieldAngle > beamAngle * 1.02)) {
    fieldAngle = Math.max(beam.fieldAngle, beam.beamAngle);
    beamAngle = undefined;
    notes.push(
      `the file gives ${beam.beamAngle}° beam and ${beam.fieldAngle}° field, so ${fieldAngle}° was taken as the field and the beam filled in from a typical ${kind} profile`,
    );
  }
  if (gdtf.summary.beams.length > 1 || gdtf.summary.hasGeometryReferences) {
    notes.push(
      'the fixture has more than one emitter and only the first was used, so its output may be understated',
    );
  }

  const photometrics = estimatePhotometrics({
    kind,
    fieldAngle,
    ...(beamAngle !== undefined ? { beamAngle } : {}),
    lumens: beam.luminousFlux,
    lumensAtLens: true,
  });
  photometrics.source =
    `GDTF beam data from ${gdtf.file}: ${beam.luminousFlux.toLocaleString('en-GB')} lm taken as output at the lens, ` +
    `${beam.beamAngle}° beam / ${beam.fieldAngle}° field. A GDTF beam is not photometry; the shape between those angles is modelled.` +
    (notes.length ? ` Note: ${notes.join('; ')}.` : '');

  return {
    id: `mvr-gdtf-${uuidV5(`gdtf:${type.key}`).slice(0, 8)}`,
    manufacturer: (gdtf.summary.manufacturer || 'Imported').slice(0, 60),
    name: (gdtf.summary.name || type.label).slice(0, 80),
    kind,
    watts: Math.round(beam.powerConsumption) || 0,
    weightKg: gdtf.summary.weightKg ?? 0,
    optics: [{ id: 'gdtf', label: 'From GDTF', photometrics }],
    notes: `Estimated from the beam geometry in ${gdtf.file}, imported with an MVR file.`,
  };
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

/** Fixtures this far off a run are snapped onto it; further, they get a run of their own. */
export const RUN_TOLERANCE_M = 0.05;
/** How far a generated structure extends past its end fixtures. */
const RUN_PAD_M = 0.25;

interface Line {
  origin: Vec3;
  dir: Vec3;
}

const distanceToLine = (p: Vec3, line: Line): number => {
  const d = sub(p, line.origin);
  return length(sub(d, scale(line.dir, dot(d, line.dir))));
};

/** Least-squares line through points: centroid plus principal axis (power iteration). */
function fitLine(points: Vec3[]): Line {
  const n = points.length;
  const c = scale(points.reduce((acc, p) => add(acc, p), vec(0, 0, 0)), 1 / n);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const d = sub(p, c);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  // Start from the axis of greatest spread; deterministic, and already close.
  let v = xx >= yy && xx >= zz ? vec(1, 0, 0) : yy >= zz ? vec(0, 1, 0) : vec(0, 0, 1);
  for (let i = 0; i < 64; i++) {
    const next = vec(
      xx * v.x + xy * v.y + xz * v.z,
      xy * v.x + yy * v.y + yz * v.z,
      xz * v.x + yz * v.y + zz * v.z,
    );
    const len = length(next);
    if (len < 1e-15) break; // every point coincides
    v = scale(next, 1 / len);
  }
  return { origin: c, dir: v };
}

/**
 * Split a group of fixture positions into straight runs, each within
 * `RUN_TOLERANCE_M` of a line.
 *
 * A hanging position is usually one straight pipe, and the first test — does
 * one line fit them all? — settles most groups at once. When it does not (a
 * position spanning two bars, or a layer holding a whole rig), take the line
 * through the pair of points that collects the most others, peel those off as
 * a run, and repeat. Deterministic: the same file always gives the same rig.
 * A point no line through two others will collect becomes a run on its own.
 */
export function splitIntoRuns(points: Vec3[], tol = RUN_TOLERANCE_M): number[][] {
  const runs: number[][] = [];
  let remaining = points.map((_, i) => i);

  while (remaining.length > 0) {
    if (remaining.length === 1) {
      runs.push(remaining);
      break;
    }
    const pts = remaining.map((i) => points[i] as Vec3);
    const whole = fitLine(pts);
    if (pts.every((p) => distanceToLine(p, whole) <= tol)) {
      runs.push(remaining);
      break;
    }

    let best: number[] = [];
    let bestSpan = 0;
    // Bounded so a pathological file (hundreds of fixtures in one layer, in no
    // particular line) stays fast; the first 64 seeds see every real bar.
    const seeds = Math.min(remaining.length, 64);
    for (let a = 0; a < seeds; a++) {
      for (let b = a + 1; b < remaining.length; b++) {
        const pa = pts[a] as Vec3;
        const pb = pts[b] as Vec3;
        const span = length(sub(pb, pa));
        if (span < tol) continue;
        const line = { origin: pa, dir: scale(sub(pb, pa), 1 / span) };
        const inliers = remaining.filter((i) => distanceToLine(points[i] as Vec3, line) <= tol);
        if (inliers.length > best.length || (inliers.length === best.length && span > bestSpan)) {
          best = inliers;
          bestSpan = span;
        }
      }
    }

    if (best.length < 2) {
      for (const i of remaining) runs.push([i]);
      break;
    }
    // Refit on the inliers and keep the refit only if it still holds them all.
    const refit = fitLine(best.map((i) => points[i] as Vec3));
    const refitInliers = remaining.filter((i) => distanceToLine(points[i] as Vec3, refit) <= tol);
    const run = refitInliers.length >= best.length ? refitInliers : best;
    runs.push(run);
    const taken = new Set(run);
    remaining = remaining.filter((i) => !taken.has(i));
  }

  return runs;
}

/** A structure spanning `points` along `line`, plus each point's distance along it. */
function runStructure(points: Vec3[]): { from: Vec3; to: Vec3; along: number[] } {
  if (points.length === 1 || points.every((p) => length(sub(p, points[0] as Vec3)) < 1e-9)) {
    // A single fixture (or a stack at one point): a short bar across the stage.
    const p = points[0] as Vec3;
    return {
      from: sub(p, vec(RUN_PAD_M, 0, 0)),
      to: add(p, vec(RUN_PAD_M, 0, 0)),
      along: points.map(() => RUN_PAD_M),
    };
  }
  const line = fitLine(points);
  // Run in the reading direction: left to right, downstage to upstage, up.
  const d = line.dir;
  const flip = Math.abs(d.x) > 1e-6 ? d.x < 0 : Math.abs(d.y) > 1e-6 ? d.y < 0 : d.z < 0;
  const dir = flip ? scale(d, -1) : d;
  const ts = points.map((p) => dot(sub(p, line.origin), dir));
  const t0 = Math.min(...ts) - RUN_PAD_M;
  const t1 = Math.max(...ts) + RUN_PAD_M;
  const from = add(line.origin, scale(dir, t0));
  return {
    from,
    to: add(line.origin, scale(dir, t1)),
    along: ts.map((t) => t - t0),
  };
}

// ---------------------------------------------------------------------------
// Building the rig
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Added to every imported position, metres. */
  offset: Vec3;
  /** Restore stagewash's own per-fixture settings and structures when the file carries them. */
  restoreStagewash: boolean;
}

export interface ImportedRig {
  name?: string;
  stage?: Project['stage'];
  plane?: Project['plane'];
  targets?: Project['targets'];
  structures: Structure[];
  fixtures: RigFixture[];
  /** Models the rig needs that are not in the library: GDTF estimates and restored customs. */
  customModels: FixtureModel[];
  /** Plain-language notes on what was left out or approximated. */
  notes: string[];
}

/**
 * Turn a read MVR into structures, fixtures and models.
 *
 * `models` is every model already available — the library and the project's
 * own — and is only read.
 */
export function buildRig(
  doc: MvrDocument,
  choices: Map<string, TypeChoice>,
  models: Map<string, FixtureModel>,
  options: ImportOptions,
): ImportedRig {
  const notes: string[] = [];
  const saved = options.restoreStagewash ? doc.stagewash : undefined;
  const offset = options.offset;
  const toStage = (mmPoint: Vec3): Vec3 => add(scale(mmPoint, 1 / 1000), offset);

  // --- models --------------------------------------------------------------
  const customModels = new Map<string, FixtureModel>();
  const gdtfModels = new Map<string, FixtureModel>();
  // Custom models a stagewash export carried are usable whether or not its
  // other settings are being restored: they are in the file either way.
  const modelFor = (id: string): FixtureModel | undefined =>
    models.get(id) ?? customModels.get(id) ?? doc.stagewash?.customModels.find((m) => m.id === id);
  const adoptModel = (model: FixtureModel): void => {
    if (!models.has(model.id)) customModels.set(model.id, model);
  };

  // --- which fixtures, as what ---------------------------------------------
  interface Placed {
    mvr: MvrFixture;
    model: FixtureModel;
    opticId: string;
    position: Vec3;
    saved?: StagewashUserData['fixtures'][string];
  }
  const placed: Placed[] = [];
  const skippedByType = new Map<string, number>();

  for (const f of doc.scene.fixtures) {
    const key = doc.typeOf.get(f.uuid);
    if (key === undefined) continue; // ignored: multipatch cell or attachment

    const savedFixture = saved?.fixtures[f.uuid];
    const savedModel = savedFixture ? modelFor(savedFixture.modelId) : undefined;
    let model: FixtureModel | undefined;
    let opticId = '';

    if (savedFixture && savedModel) {
      model = savedModel;
      opticId = savedFixture.opticId;
    } else {
      const choice = choices.get(key) ?? { kind: 'skip' };
      if (choice.kind === 'model') {
        model = modelFor(choice.modelId);
        opticId = choice.opticId;
      } else if (choice.kind === 'gdtf') {
        const type = doc.types.find((t) => t.key === key);
        if (type) {
          let m = gdtfModels.get(key);
          if (!m) {
            m = modelFromGdtf(type);
            if (m) gdtfModels.set(key, m);
          }
          model = m;
          opticId = m?.optics[0]?.id ?? '';
        }
      }
    }

    if (!model) {
      skippedByType.set(key, (skippedByType.get(key) ?? 0) + 1);
      continue;
    }
    adoptModel(model);
    const optic = findOptic(model, opticId);
    placed.push({
      mvr: f,
      model,
      opticId: optic?.id ?? opticId,
      position: toStage(f.transform.o),
      ...(savedFixture && savedModel ? { saved: savedFixture } : {}),
    });
  }

  for (const [key, count] of skippedByType) {
    const label = doc.types.find((t) => t.key === key)?.label ?? key;
    notes.push(`${count} × ${label} left out: no fixture model was chosen for it.`);
  }
  if (doc.ignored.length > 0) {
    notes.push(
      `${doc.ignored.length} fixture node${doc.ignored.length === 1 ? '' : 's'} skipped as parts of other fixtures (multipatch cells or attachments).`,
    );
  }

  // --- structures ----------------------------------------------------------
  interface Group {
    key: string;
    name: string;
    kind: StructureKind;
    positionUuid?: string;
    members: number[];
  }
  const groups = new Map<string, Group>();
  // Capture writes most of its groups with no name at all; number them per
  // layer so the rig panel does not list six structures called "GroupObject".
  const unnamed = new Map<string, number>();
  const nameFor = (containerKey: string, given: string, layerName: string): string => {
    if (given.trim()) return given.trim();
    let n = unnamed.get(containerKey);
    if (n === undefined) {
      n = [...unnamed.keys()].filter((k) => k.startsWith(`${layerName}\u0000`)).length + 1;
      unnamed.set(containerKey, n);
    }
    return `${layerName || 'Layer'} group ${n}`;
  };
  placed.forEach((p, index) => {
    const f = p.mvr;
    let key: string;
    let name: string;
    let kind: StructureKind = 'bar';
    let positionUuid: string | undefined;
    if (f.position) {
      key = `position:${f.position}`;
      name = doc.scene.positions.get(f.position) || 'Position';
      positionUuid = f.position;
    } else if (f.parent && f.parent.kind !== 'Layer') {
      key = `${f.parent.kind}:${f.parent.uuid}`;
      name = nameFor(`${f.layer.name}\u0000${key}`, f.parent.name, f.layer.name);
      if (f.parent.kind === 'Truss') kind = 'truss';
    } else {
      key = `layer:${f.layer.uuid}`;
      name = f.layer.name || 'Layer';
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, name, kind, members: [], ...(positionUuid ? { positionUuid } : {}) };
      groups.set(key, group);
    }
    group.members.push(index);
  });

  const structures: Structure[] = [];
  const fixtureStructure = new Map<number, { structureId: string; along: number }>();
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };
  let maxSnap = 0;

  for (const group of groups.values()) {
    const points = group.members.map((i) => (placed[i] as Placed).position);

    // A stagewash structure that came out under this position, if every
    // fixture still sits on it: keep it exactly, kind, SWL and all. A floor
    // is a run like any other as far as positions go.
    const savedStructure = group.positionUuid ? saved?.structures[group.positionUuid] : undefined;
    if (savedStructure) {
      const from = add(savedStructure.from, offset);
      const to = add(savedStructure.to, offset);
      const span = length(sub(to, from));
      const dir = span > 1e-9 ? scale(sub(to, from), 1 / span) : vec(1, 0, 0);
      const fits = points.every((p) => {
        const t = dot(sub(p, from), dir);
        return t >= -1e-6 && t <= span + 1e-6 && distanceToLine(p, { origin: from, dir }) <= 1e-4;
      });
      if (fits) {
        const id = uniqueId(savedStructure.id);
        structures.push({ ...savedStructure, id, from, to, mvrUuid: group.positionUuid });
        group.members.forEach((i, k) => {
          fixtureStructure.set(i, { structureId: id, along: dot(sub(points[k] as Vec3, from), dir) });
        });
        continue;
      }
    }

    const runs = splitIntoRuns(points);
    runs.forEach((run, r) => {
      const runPoints = run.map((k) => points[k] as Vec3);
      const { from, to, along } = runStructure(runPoints);
      const slug = group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';
      const id = uniqueId(`mvr-${slug}`);
      const base: Structure = {
        id,
        name: runs.length > 1 ? `${group.name} (${r + 1})` : group.name,
        kind: group.kind,
        from,
        to,
        ...(savedStructure ? pickStructureExtras(savedStructure) : {}),
        ...(group.positionUuid && runs.length === 1 ? { mvrUuid: group.positionUuid } : {}),
      };
      structures.push(base);
      run.forEach((k, j) => {
        const memberIndex = group.members[k] as number;
        fixtureStructure.set(memberIndex, { structureId: id, along: along[j] as number });
        const snapped = add(from, scale(normalise(sub(to, from)), along[j] as number));
        maxSnap = Math.max(maxSnap, length(sub(snapped, points[k] as Vec3)));
      });
    });
  }

  // Structures stagewash exported with nothing hung on them.
  if (saved) {
    const present = new Set([...groups.values()].map((g) => g.positionUuid).filter(Boolean));
    for (const [uuid, s] of Object.entries(saved.structures)) {
      if (present.has(uuid)) continue;
      structures.push({
        ...s,
        id: uniqueId(s.id),
        from: add(s.from, offset),
        to: add(s.to, offset),
        mvrUuid: uuid,
      });
    }
  }

  if (maxSnap > 0.005) {
    notes.push(
      `Fixtures were moved up to ${(maxSnap * 100).toFixed(1)} cm to sit on a straight run.`,
    );
  }

  // --- fixtures ------------------------------------------------------------
  const usedFixtureIds = new Set<string>();
  let nextChannel =
    placed.reduce((max, p) => {
      const n = Number.parseInt(p.mvr.fixtureId, 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;

  const fixtures: RigFixture[] = placed.map((p, index) => {
    const f = p.mvr;
    const where = fixtureStructure.get(index) as { structureId: string; along: number };

    // Channel: FixtureID as written, then the numeric one, then the next free
    // number. "0" is what several tools write for "unset".
    let channel = f.fixtureId.trim();
    if (!channel || channel === '0') {
      channel = f.fixtureIdNumeric && f.fixtureIdNumeric > 0 ? String(f.fixtureIdNumeric) : '';
    }
    if (!channel) channel = String(nextChannel++);

    // Where it points.
    const bodyBeam = normalise(scale(rotate(f.transform, vec(0, 0, 1)), -1));
    const focus = f.focus ? doc.scene.focusPoints.get(f.focus) : undefined;
    const focusAt = focus ? toStage(focus.transform.o) : undefined;
    const direction =
      focusAt && length(sub(focusAt, p.position)) > 1e-6
        ? normalise(sub(focusAt, p.position))
        : bodyBeam;
    const angles = panTiltFromDirection(direction);
    // Straight up or down, pan is undefined; atan2 of two signed zeros says
    // ±180, which is true and unhelpful.
    const pan = Math.hypot(direction.x, direction.y) < 1e-9 ? 0 : angles.pan;
    const tilt = angles.tilt;

    // Roll is read off the body only when the body is what points the beam —
    // a moving head's base says nothing about rotation about its beam.
    let roll = 0;
    if (!MOVING_KINDS.has(p.model.kind) && dot(bodyBeam, direction) > Math.cos((1 * Math.PI) / 180)) {
      const frame = fixtureFrame(direction, 0);
      const u = rotate(f.transform, vec(1, 0, 0));
      roll = (Math.atan2(dot(u, frame.up), dot(u, frame.right)) * 180) / Math.PI;
      if (Math.abs(roll) < 1e-6) roll = 0;
    }

    const aimFallback = beamOnDeck(p.position, direction);
    const s = p.saved;
    const focusMode = s ? s.focusMode : focusAt ? 'aim' : 'angles';
    const id = s && !usedFixtureIds.has(s.id) ? s.id : `mvr-${f.uuid}`;
    usedFixtureIds.add(id);

    return {
      id,
      channel,
      modelId: p.model.id,
      opticId: p.opticId,
      structureId: where.structureId,
      along: where.along,
      position: p.position,
      focusMode,
      aim: focusAt ?? aimFallback,
      pan,
      tilt,
      roll: s ? s.roll : roll,
      ...(s?.zoom !== undefined ? { zoom: s.zoom } : {}),
      level: s ? s.level : 1,
      transmission: s ? s.transmission : 1,
      ...(s?.gelName !== undefined ? { gelName: s.gelName } : {}),
      enabled: s ? s.enabled : true,
      mvrUuid: f.uuid,
    };
  });

  for (const m of gdtfModels.values()) {
    notes.push(
      `${m.manufacturer} ${m.name} is estimated from its GDTF beam figures — the file has no photometry. Import the manufacturer's IES file for measured levels.`,
    );
  }

  return {
    ...(saved
      ? { name: saved.name, stage: saved.stage, plane: saved.plane, targets: saved.targets }
      : {}),
    structures,
    fixtures,
    customModels: [...customModels.values()],
    notes,
  };
}

function pickStructureExtras(s: Structure): Partial<Structure> {
  return {
    kind: s.kind,
    ...(s.sizeM !== undefined ? { sizeM: s.sizeM } : {}),
    ...(s.swlKg !== undefined ? { swlKg: s.swlKg } : {}),
    ...(s.maxHeightM !== undefined ? { maxHeightM: s.maxHeightM } : {}),
    ...(s.colour !== undefined ? { colour: s.colour } : {}),
  };
}

/** Where the beam meets the deck (z = 0), or 5 m along it — the aim offered if the user switches to aim mode. */
function beamOnDeck(from: Vec3, dir: Vec3): Vec3 {
  if (dir.z < -1e-6) {
    const t = -from.z / dir.z;
    if (t > 0) return vec(from.x + dir.x * t, from.y + dir.y * t, 0);
  }
  return add(from, scale(dir, 5));
}

// ---------------------------------------------------------------------------
// Placing the rig on the stage
// ---------------------------------------------------------------------------

/**
 * An offset that puts the rig over stagewash's stage.
 *
 * MVR files keep whatever origin the drawing had — a Vectorworks plot is often
 * centred on the plaster line, sometimes on a corner of the venue. Stagewash
 * measures a stage whose downstage edge centre is the origin. Centre the
 * focus points (which are on the stage, by definition) over the stage; with no
 * focus points, centre the fixtures in plan. Heights are left alone.
 */
export function suggestOffset(doc: MvrDocument, stage: Project['stage']): Vec3 {
  const focusPoints = [...doc.scene.focusPoints.values()].map((fp) => originM(fp.transform));
  const points =
    focusPoints.length > 0
      ? focusPoints
      : doc.scene.fixtures.filter((f) => doc.typeOf.has(f.uuid)).map((f) => originM(f.transform));
  if (points.length === 0) return vec(0, 0, 0);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return vec(round(-cx), round(stage.depthM / 2 - cy), 0);
}

/** Plan extent of the fixtures and focus points, metres, before any offset. */
export function planExtent(doc: MvrDocument): { min: Vec3; max: Vec3 } | undefined {
  const points = [
    ...doc.scene.fixtures.filter((f) => doc.typeOf.has(f.uuid)).map((f) => originM(f.transform)),
    ...[...doc.scene.focusPoints.values()].map((fp) => originM(fp.transform)),
  ];
  if (points.length === 0) return undefined;
  return {
    min: vec(Math.min(...points.map((p) => p.x)), Math.min(...points.map((p) => p.y)), Math.min(...points.map((p) => p.z))),
    max: vec(Math.max(...points.map((p) => p.x)), Math.max(...points.map((p) => p.y)), Math.max(...points.map((p) => p.z))),
  };
}
