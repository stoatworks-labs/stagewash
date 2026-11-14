/**
 * A stagewash project as an MVR scene.
 *
 * What goes where:
 *
 * - Each **structure** becomes a `<Truss>` with a box of its run and section
 *   (see `glb.ts`) and an `AUXData/<Position>` of the same name — the
 *   "hanging position" a plot calls LX1 or FOH bar. Its fixtures reference
 *   that position, which is also how the importer puts them back on one bar.
 * - Each **fixture** becomes a `<Fixture>`: its channel as `FixtureID`, its
 *   world position, and a rotation whose −Z is the beam axis (GDTF hangs every
 *   fixture beam-down). A fixture focused on a point also gets a
 *   `<FocusPoint>` there and a `<Focus>` reference to it.
 * - A **moving head** is the exception to rotating the body. Its MVR matrix
 *   is the base, hung or standing; where it points is a pan/tilt state, not a
 *   mounting, so it is sent as a focus point and never as a tilted base.
 * - Everything MVR has no slot for — model and optic, zoom, level, gel,
 *   custom photometry, the stage and the measurement plane — goes in
 *   `UserData` under provider `stagewash`, keyed by UUID. The spec warns that
 *   user data "should not be expected to be preserved" through other tools,
 *   and the importer copes when it is not.
 *
 * No GDTF files are written. Stagewash's fixture models are photometric, not
 * device descriptions, and an invented GDTF that a strict receiver rejects is
 * worse than none: every receiver handles a missing type by asking the user to
 * map it to its own library, which is what a designer does anyway.
 */

import { cross, dot, fixtureFrame, normalise, runLength, scale, sub, vec } from '../geometry';
import { findOptic, resolveDirection, resolvePosition } from '../rig';
import type { FixtureModel, Project, RigFixture, Structure, Vec3 } from '../types';
import { MOVING_KINDS } from '../types';
import { boxGlb } from './glb';
import { beamTransform, formatMatrix, IDENTITY, MM_PER_M, type Transform } from './matrix';
import { uuidV5 } from './uuid';
import { escapeXml } from './xml';
import { SCENE_FILE, writeMvrArchive } from './archive';

export const STAGEWASH_PROVIDER = 'stagewash';
export const USERDATA_VERSION = '1';

/** What stagewash puts in its `UserData` block. */
export interface StagewashUserData {
  format: 'stagewash-mvr';
  version: 1;
  name: string;
  stage: Project['stage'];
  plane: Project['plane'];
  targets: Project['targets'];
  /** Every structure, keyed by the UUID of the `<Position>` it was exported as. */
  structures: Record<string, Structure>;
  /** Per-fixture settings MVR has no slot for, keyed by the fixture's UUID. */
  fixtures: Record<string, StagewashFixtureData>;
  /** Project-local fixture models the exported fixtures use. */
  customModels: FixtureModel[];
}

export type StagewashFixtureData = Pick<
  RigFixture,
  'id' | 'modelId' | 'opticId' | 'structureId' | 'focusMode' | 'pan' | 'tilt' | 'roll' | 'level' | 'transmission' | 'enabled'
> &
  Partial<Pick<RigFixture, 'zoom' | 'gelName'>>;

/** UUID of an exported object: the one it arrived with if it came from an MVR, else a stable derived one. */
export const fixtureUuid = (f: RigFixture): string => f.mvrUuid ?? uuidV5(`fixture:${f.id}`);
export const positionUuid = (s: Structure): string => s.mvrUuid ?? uuidV5(`position:${s.id}`);
const trussUuid = (s: Structure): string => uuidV5(`truss:${s.id}`);

/**
 * The `GDTFSpec` a model is exported under: `Manufacturer@Name.gdtf`, the
 * GDTF Share naming pattern, so a receiver that searches its library by name
 * has a fair chance. No such file is in the archive (see the module comment).
 */
export function gdtfSpecFor(model: FixtureModel): string {
  const clean = (s: string): string =>
    s
      .replace(/°/g, 'deg')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/[<>:"/\\|?*@.]+/g, '_')
      .replace(/[^\x20-\x7e]+/g, '')
      .trim();
  return `${clean(model.manufacturer) || 'Unknown'}@${clean(model.name) || 'Fixture'}.gdtf`;
}

const mm = (p: Vec3): Vec3 => scale(p, MM_PER_M);

/** Where a beam along `dir` from `from` meets the plane `z = planeZ`, or 5 m along it if it never does. */
function beamTarget(from: Vec3, dir: Vec3, planeZ: number): Vec3 {
  const d = normalise(dir);
  if (d.z < -1e-6) {
    const t = (planeZ - from.z) / d.z;
    if (t > 0) return vec(from.x + d.x * t, from.y + d.y * t, planeZ);
  }
  return vec(from.x + d.x * 5, from.y + d.y * 5, from.z + d.z * 5);
}

/** A structure's frame: origin at `from`, local X along the run. */
function structureTransform(s: Structure): Transform {
  const span = sub(s.to, s.from);
  const u = runLength(s.from, s.to) > 1e-9 ? normalise(span) : vec(1, 0, 0);
  // Any perpendicular will do for a square box; prefer one with Z in it so the
  // box's faces sit square to the deck on a horizontal run.
  const ref = Math.abs(u.z) > 0.9999 ? vec(0, 1, 0) : vec(0, 0, 1);
  const w = normalise(sub(ref, scale(u, dot(u, ref))));
  return { u, v: cross(w, u), w, o: mm(s.from) };
}

export interface MvrExport {
  /** File name → contents, ready to zip. */
  files: Record<string, string | Uint8Array>;
  /** Fixtures left out, with why. */
  skipped: string[];
}

export function buildMvrFiles(
  project: Project,
  models: Map<string, FixtureModel>,
  providerVersion: string,
): MvrExport {
  const structures = new Map(project.structures.map((s) => [s.id, s]));
  const files: Record<string, string | Uint8Array> = {};
  const skipped: string[] = [];
  const objects: string[] = [];
  const aux: string[] = [];

  const data: StagewashUserData = {
    format: 'stagewash-mvr',
    version: 1,
    name: project.name,
    stage: project.stage,
    plane: project.plane,
    targets: project.targets,
    structures: {},
    fixtures: {},
    customModels: [],
  };

  const usedUuids = new Set<string>();
  const positionUuids = new Map<string, string>();

  // --- structures ----------------------------------------------------------
  for (const s of project.structures) {
    let pos = positionUuid(s);
    if (usedUuids.has(pos)) pos = uuidV5(`position:${s.id}`);
    usedUuids.add(pos);
    positionUuids.set(s.id, pos);
    data.structures[pos] = s;
    aux.push(`      <Position uuid="${pos}" name="${escapeXml(s.name)}"/>`);
    // `floor` is a virtual structure — the deck — and has nothing to draw.
    if (s.kind === 'floor') continue;

    const glbName = `${trussUuid(s)}.glb`;
    files[glbName] = boxGlb(runLength(s.from, s.to), s.sizeM ?? 0.05);
    objects.push(
      [
        `        <Truss uuid="${trussUuid(s)}" name="${escapeXml(s.name)}">`,
        `          <Matrix>${formatMatrix(structureTransform(s))}</Matrix>`,
        `          <Position>${pos}</Position>`,
        `          <Geometries>`,
        `            <Geometry3D fileName="${glbName}"/>`,
        `          </Geometries>`,
        `          <FixtureID></FixtureID>`,
        `          <FixtureIDNumeric>0</FixtureIDNumeric>`,
        `        </Truss>`,
      ].join('\n'),
    );
  }

  // --- fixtures ------------------------------------------------------------
  const focusPoints = new Map<string, { uuid: string; at: Vec3; channels: string[] }>();
  const unitOnStructure = new Map<string, number>();
  const usedCustom = new Set<string>();
  const customIds = new Set(project.customModels.map((m) => m.id));

  for (const fixture of project.fixtures) {
    const model = models.get(fixture.modelId);
    const structure = structures.get(fixture.structureId);
    if (!model || !structure) {
      skipped.push(
        `Channel ${fixture.channel}: ${model ? 'its structure no longer exists' : `model "${fixture.modelId}" is not in the library`}.`,
      );
      continue;
    }
    if (customIds.has(model.id)) usedCustom.add(model.id);
    const optic = findOptic(model, fixture.opticId);

    const position = resolvePosition(fixture, structure);
    const direction = normalise(resolveDirection(fixture, position));
    const moving = MOVING_KINDS.has(model.kind);

    let transform: Transform;
    if (moving) {
      // The base, not the beam. Hung unless it stands on the deck or a stand.
      const standing = structure.kind === 'floor' || structure.kind === 'stand';
      transform = standing
        ? { u: vec(1, 0, 0), v: vec(0, -1, 0), w: vec(0, 0, -1), o: mm(position) }
        : { ...IDENTITY, o: mm(position) };
    } else {
      const frame = fixtureFrame(direction, fixture.roll);
      transform = beamTransform(direction, frame.right, mm(position));
    }

    // A focus point for anything aimed at one, and for every moving head —
    // its matrix says nothing about where it points, so without one a
    // receiver would draw it at home, straight down.
    let focusUuid: string | undefined;
    if (fixture.focusMode === 'aim' || moving) {
      const at =
        fixture.focusMode === 'aim'
          ? fixture.aim
          : beamTarget(position, direction, project.stage.heightM);
      const key = `${Math.round(at.x * 1000)},${Math.round(at.y * 1000)},${Math.round(at.z * 1000)}`;
      let fp = focusPoints.get(key);
      if (!fp) {
        fp = { uuid: uuidV5(`focus:${key}`), at, channels: [] };
        focusPoints.set(key, fp);
      }
      fp.channels.push(fixture.channel);
      focusUuid = fp.uuid;
    }

    // An imported UUID is reused, but never twice: a receiver keys on it.
    let uuid = fixtureUuid(fixture);
    if (usedUuids.has(uuid)) uuid = uuidV5(`fixture:${fixture.id}`);
    usedUuids.add(uuid);
    const unit = (unitOnStructure.get(structure.id) ?? 0) + 1;
    unitOnStructure.set(structure.id, unit);
    const numeric = /^\d+$/.test(fixture.channel.trim()) ? Number.parseInt(fixture.channel, 10) : 0;
    const name = model.optics.length > 1 && optic ? `${model.name} ${optic.label}` : model.name;

    objects.push(
      [
        `        <Fixture uuid="${uuid}" name="${escapeXml(name)}">`,
        `          <Matrix>${formatMatrix(transform)}</Matrix>`,
        `          <GDTFSpec>${escapeXml(gdtfSpecFor(model))}</GDTFSpec>`,
        `          <GDTFMode>Default</GDTFMode>`,
        ...(focusUuid ? [`          <Focus>${focusUuid}</Focus>`] : []),
        `          <Position>${positionUuids.get(structure.id)}</Position>`,
        `          <FixtureID>${escapeXml(fixture.channel)}</FixtureID>`,
        `          <FixtureIDNumeric>${numeric}</FixtureIDNumeric>`,
        `          <UnitNumber>${unit}</UnitNumber>`,
        `          <CastShadow>false</CastShadow>`,
        `        </Fixture>`,
      ].join('\n'),
    );

    data.fixtures[uuid] = {
      id: fixture.id,
      modelId: fixture.modelId,
      opticId: fixture.opticId,
      structureId: fixture.structureId,
      focusMode: fixture.focusMode,
      pan: fixture.pan,
      tilt: fixture.tilt,
      roll: fixture.roll,
      level: fixture.level,
      transmission: fixture.transmission,
      enabled: fixture.enabled,
      ...(fixture.zoom !== undefined ? { zoom: fixture.zoom } : {}),
      ...(fixture.gelName !== undefined ? { gelName: fixture.gelName } : {}),
    };
  }

  for (const fp of focusPoints.values()) {
    objects.push(
      [
        `        <FocusPoint uuid="${fp.uuid}" name="${escapeXml(`Focus ${fp.channels.join(', ')}`.slice(0, 60))}">`,
        `          <Matrix>${formatMatrix({ ...IDENTITY, o: mm(fp.at) })}</Matrix>`,
        `          <Geometries/>`,
        `        </FocusPoint>`,
      ].join('\n'),
    );
  }

  data.customModels = project.customModels.filter((m) => usedCustom.has(m.id));

  // CDATA keeps the JSON readable. The one sequence CDATA cannot hold is its
  // own terminator, which can only occur inside a JSON string, so split it.
  const json = JSON.stringify(data).replace(/]]>/g, ']]]]><![CDATA[>');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    `<GeneralSceneDescription verMajor="1" verMinor="6" provider="${STAGEWASH_PROVIDER}" providerVersion="${escapeXml(providerVersion)}">`,
    '  <UserData>',
    `    <Data provider="${STAGEWASH_PROVIDER}" ver="${USERDATA_VERSION}"><![CDATA[${json}]]></Data>`,
    '  </UserData>',
    '  <Scene>',
    '    <AUXData>',
    ...aux,
    '    </AUXData>',
    '    <Layers>',
    `      <Layer uuid="${uuidV5('layer:rig')}" name="${escapeXml(project.name || 'stagewash rig')}">`,
    '        <ChildList>',
    ...objects,
    '        </ChildList>',
    '      </Layer>',
    '    </Layers>',
    '  </Scene>',
    '</GeneralSceneDescription>',
    '',
  ].join('\n');

  files[SCENE_FILE] = xml;
  return { files, skipped };
}

/** The whole `.mvr`, zipped. */
export function exportMvr(
  project: Project,
  models: Map<string, FixtureModel>,
  providerVersion: string,
): { bytes: Uint8Array; skipped: string[] } {
  const { files, skipped } = buildMvrFiles(project, models, providerVersion);
  return { bytes: writeMvrArchive(files), skipped };
}
