import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { FIXTURE_LIBRARY } from '../../data/fixtures';
import { defaultProject } from '../../state/defaultProject';
import { cross, dot, length, normalise, sub } from '../geometry';
import { modelIndex, prepareRig, resolveDirection, resolvePosition } from '../rig';
import { buildSampleField, solve } from '../solver';
import type { Grid, Project, RigFixture } from '../types';
import { SCENE_FILE } from '../mvr/archive';
import { boxGlb } from '../mvr/glb';
import { buildMvrFiles, exportMvr, gdtfSpecFor } from '../mvr/exportRig';
import {
  buildRig,
  readMvr,
  splitIntoRuns,
  suggestChoices,
  type ImportedRig,
  type TypeChoice,
} from '../mvr/importRig';
import { beamTransform, compose, formatMatrix, isRigidRotation, originM, parseMatrix, rotate } from '../mvr/matrix';
import { normaliseUuid, parseScene } from '../mvr/scene';
import { DNS_NAMESPACE, uuidV5 } from '../mvr/uuid';
import { parseXml, XmlParseError } from '../mvr/xml';

const library = modelIndex(FIXTURE_LIBRARY, []);
const NO_OFFSET = { x: 0, y: 0, z: 0 };

function solveGrid(project: Project): Grid {
  const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
  const { fixtures } = prepareRig(project, models);
  return solve(fixtures, buildSampleField(project.stage, project.plane)).grid;
}

/** The project an import would produce: the current one with its rig replaced. */
function applyImport(base: Project, rig: ImportedRig): Project {
  return {
    ...base,
    ...(rig.name !== undefined ? { name: rig.name } : {}),
    ...(rig.stage ? { stage: rig.stage } : {}),
    ...(rig.plane ? { plane: rig.plane } : {}),
    ...(rig.targets ? { targets: rig.targets } : {}),
    structures: rig.structures,
    fixtures: rig.fixtures,
    customModels: [...base.customModels, ...rig.customModels],
  };
}

function roundTrip(project: Project, mutate?: (xml: string) => string): { doc: ReturnType<typeof readMvr>; bytes: Uint8Array } {
  const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
  let { bytes } = exportMvr(project, models, 'test');
  if (mutate) {
    const files = unzipSync(bytes);
    files[SCENE_FILE] = strToU8(mutate(strFromU8(files[SCENE_FILE]!)));
    bytes = zipSync(files);
  }
  return { doc: readMvr(bytes), bytes };
}

const stripUserData = (xml: string): string => xml.replace(/<UserData>[\s\S]*?<\/UserData>/, '');

const maxRelativeDifference = (a: Grid, b: Grid): number => {
  expect(a.lux.length).toBe(b.lux.length);
  let peak = 0;
  for (let i = 0; i < a.lux.length; i++) peak = Math.max(peak, a.lux[i] as number);
  let worst = 0;
  for (let i = 0; i < a.lux.length; i++) {
    worst = Math.max(worst, Math.abs((a.lux[i] as number) - (b.lux[i] as number)) / peak);
  }
  return worst;
};

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

describe('XML reader', () => {
  it('reads attributes, entities, CDATA and nesting', () => {
    const root = parseXml(
      '﻿<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'&quot;q&quot;\'><b>t&#x2013;u</b><c><![CDATA[<raw> & ]]></c><d/></a>',
    );
    expect(root.name).toBe('a');
    expect(root.attrs).toEqual({ x: '1 & 2', y: '"q"' });
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c', 'd']);
    expect(root.children[0]!.text).toBe('t–u');
    expect(root.children[1]!.text).toBe('<raw> &');
  });

  it('survives the `<!-->…</!-->` pseudo-comment the MVR spec itself prints', () => {
    const root = parseXml('<F><!-->a note</!--><G/></F>');
    expect(root.children.map((c) => c.name)).toEqual(['G']);
  });

  it('refuses a mismatched closing tag rather than guessing', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(XmlParseError);
  });
});

describe('UUIDs', () => {
  it('is RFC 4122 version 5 — the standard example comes out right', () => {
    expect(uuidV5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is stable for a name and different between names', () => {
    expect(uuidV5('fixture:a')).toBe(uuidV5('fixture:a'));
    expect(uuidV5('fixture:a')).not.toBe(uuidV5('fixture:b'));
  });

  it('normalises the three spellings real files use', () => {
    const want = '4ab19462-a6e3-4c3b-b25a-d8099f78170c';
    expect(normaliseUuid('4AB19462-A6E3-4C3B-B25A-D8099F78170C')).toBe(want);
    expect(normaliseUuid('4A B1 94 62 A6 E3 4C 3B B2 5A D8 09 9F 78 17 0C')).toBe(want);
    expect(normaliseUuid(want)).toBe(want);
  });
});

describe('matrices', () => {
  it('round-trips through text exactly enough', () => {
    const t = parseMatrix('{0.158127,-0.987419,0}{0.987419,0.158127,0}{0,0,1}{6020.9392,2838.588955,4978.134459}');
    expect(parseMatrix(formatMatrix(t))).toEqual(t);
  });

  it('treats a missing matrix as identity, as the spec says', () => {
    expect(parseMatrix(undefined)).toEqual(parseMatrix('{1,0,0}{0,1,0}{0,0,1}{0,0,0}'));
  });

  it('composes parent and child: a group rotated 90° carries its child round with it', () => {
    const group = parseMatrix('{0,1,0}{-1,0,0}{0,0,1}{1000,0,0}');
    const child = parseMatrix('{1,0,0}{0,1,0}{0,0,1}{500,0,0}');
    const world = compose(group, child);
    expect(originM(world)).toEqual({ x: 1, y: 0.5, z: 0 });
  });

  it('builds a rigid rotation whose −Z is the beam', () => {
    for (const beam of [
      { x: 0, y: 0, z: -1 },
      { x: 0.3, y: 0.8, z: -0.5 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ]) {
      const d = normalise(beam);
      const right = normalise(Math.abs(d.z) > 0.9999 ? { x: 1, y: 0, z: 0 } : cross(d, { x: 0, y: 0, z: 1 }));
      const t = beamTransform(d, right, { x: 0, y: 0, z: 0 });
      expect(isRigidRotation(t)).toBe(true);
      const out = rotate(t, { x: 0, y: 0, z: -1 });
      expect(length(sub(out, d))).toBeLessThan(1e-12);
    }
  });
});

describe('splitting fixtures into straight runs', () => {
  const p = (x: number, y: number, z = 6) => ({ x, y, z });

  it('keeps one straight bar as one run', () => {
    expect(splitIntoRuns([p(-3, 0), p(-1, 0), p(1, 0), p(3, 0)])).toEqual([[0, 1, 2, 3]]);
  });

  it('separates two parallel bars that share a hanging position', () => {
    const runs = splitIntoRuns([p(-3, 0), p(3, 2), p(-1, 0), p(1, 2), p(1, 0), p(-1, 2)]);
    expect(runs.map((r) => [...r].sort())).toEqual([
      [0, 2, 4],
      [1, 3, 5],
    ]);
  });

  it('gives a stray fixture a run of its own', () => {
    const runs = splitIntoRuns([p(-2, 0), p(0, 0), p(2, 0), p(0, 4, 3)]);
    expect(runs).toContainEqual([3]);
  });

  it('copes with a stack of fixtures at one point', () => {
    expect(splitIntoRuns([p(1, 1), p(1, 1), p(1, 1)])).toEqual([[0, 1, 2]]);
  });
});

describe('GLB placeholder geometry', () => {
  it('is a valid glTF 2.0 binary of the right size', () => {
    const glb = boxGlb(12, 0.29);
    const view = new DataView(glb.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
    expect(glb.byteLength % 4).toBe(0);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    expect(json.accessors[0].max[0]).toBeCloseTo(12, 6);
    expect(json.accessors[0].max[1]).toBeCloseTo(0.145, 6);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('exporting the default rig', () => {
  const project = defaultProject();
  const { files, skipped } = buildMvrFiles(project, library, 'test');
  const scene = parseScene(files[SCENE_FILE] as string);

  it('writes every fixture, every structure and a box for each', () => {
    expect(skipped).toEqual([]);
    expect(scene.fixtures).toHaveLength(project.fixtures.length);
    expect(scene.trusses).toHaveLength(3);
    expect(scene.positions.size).toBe(3);
    expect(Object.keys(files).filter((n) => n.endsWith('.glb'))).toHaveLength(3);
  });

  it('carries channels as FixtureID, hanging positions by name, and millimetres', () => {
    const structures = new Map(project.structures.map((s) => [s.id, s]));
    for (const fixture of project.fixtures) {
      const mvr = scene.fixtures.find((f) => f.fixtureId === fixture.channel)!;
      expect(mvr).toBeDefined();
      expect(scene.positions.get(mvr.position!)).toBe(structures.get(fixture.structureId)!.name);
      const position = resolvePosition(fixture, structures.get(fixture.structureId));
      expect(length(sub(originM(mvr.transform), position))).toBeLessThan(1e-9);
      expect(mvr.gdtfSpec).toBe(gdtfSpecFor(library.get(fixture.modelId)!));
    }
  });

  it('points each fixture’s −Z down its beam and gives aimed fixtures a focus point', () => {
    const structures = new Map(project.structures.map((s) => [s.id, s]));
    for (const fixture of project.fixtures) {
      const mvr = scene.fixtures.find((f) => f.fixtureId === fixture.channel)!;
      const position = resolvePosition(fixture, structures.get(fixture.structureId));
      const beam = normalise(resolveDirection(fixture, position));
      expect(isRigidRotation(mvr.transform)).toBe(true);
      expect(length(sub(rotate(mvr.transform, { x: 0, y: 0, z: -1 }), beam))).toBeLessThan(1e-9);
      const fp = scene.focusPoints.get(mvr.focus!)!;
      expect(length(sub(originM(fp.transform), fixture.aim))).toBeLessThan(1e-9);
    }
  });

  it('uses no file name that differs from another only by case, and none in a folder', () => {
    const names = Object.keys(files);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(names.every((n) => !n.includes('/'))).toBe(true);
  });

  it('gives the same rig the same UUIDs every time', () => {
    const again = parseScene(buildMvrFiles(project, library, 'test').files[SCENE_FILE] as string);
    expect(again.fixtures.map((f) => f.uuid)).toEqual(scene.fixtures.map((f) => f.uuid));
  });
});

describe('exporting a moving head', () => {
  it('sends the base hung level and the aim as a focus point — never a tilted base', () => {
    const project = defaultProject();
    const mover: RigFixture = {
      ...project.fixtures[0]!,
      id: 'mover',
      channel: '101',
      modelId: 'generic-moving-spot-350',
      opticId: 'zoom',
      aim: { x: 2, y: 3, z: 0 },
    };
    project.fixtures = [mover];
    const scene = parseScene(buildMvrFiles(project, library, 'test').files[SCENE_FILE] as string);
    const f = scene.fixtures[0]!;
    expect(rotate(f.transform, { x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 0, z: -1 });
    expect(originM(scene.focusPoints.get(f.focus!)!.transform)).toEqual({ x: 2, y: 3, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe('round trip through MVR, with stagewash’s own data intact', () => {
  const project = defaultProject();
  const { doc } = roundTrip(project);
  const rig = buildRig(doc, suggestChoices(doc, library), library, {
    offset: NO_OFFSET,
    restoreStagewash: true,
  });
  const back = applyImport(defaultProject(), rig);

  it('restores every fixture’s settings exactly', () => {
    expect(rig.fixtures).toHaveLength(project.fixtures.length);
    for (const original of project.fixtures) {
      const f = rig.fixtures.find((x) => x.id === original.id)!;
      expect(f).toBeDefined();
      expect(f).toMatchObject({
        channel: original.channel,
        modelId: original.modelId,
        opticId: original.opticId,
        structureId: original.structureId,
        focusMode: original.focusMode,
        roll: original.roll,
        level: original.level,
        transmission: original.transmission,
        enabled: original.enabled,
      });
      expect(f.gelName).toBe(original.gelName);
      expect(f.zoom).toBe(original.zoom);
      expect(length(sub(f.aim, original.aim))).toBeLessThan(1e-9);
    }
  });

  it('restores the structures, kind and SWL included', () => {
    expect(rig.structures).toHaveLength(project.structures.length);
    for (const original of project.structures) {
      const s = rig.structures.find((x) => x.id === original.id)!;
      expect(s).toMatchObject({ name: original.name, kind: original.kind, swlKg: original.swlKg, sizeM: original.sizeM });
      expect(length(sub(s.from, original.from))).toBeLessThan(1e-9);
      expect(length(sub(s.to, original.to))).toBeLessThan(1e-9);
    }
  });

  it('solves to the same light levels, cell for cell', () => {
    expect(maxRelativeDifference(solveGrid(project), solveGrid(back))).toBeLessThan(1e-6);
  });

  it('exports the imported rig with the UUIDs it arrived with', () => {
    const again = parseScene(buildMvrFiles(back, library, 'test').files[SCENE_FILE] as string);
    expect(new Set(again.fixtures.map((f) => f.uuid))).toEqual(new Set(doc.scene.fixtures.map((f) => f.uuid)));
  });
});

describe('round trip through a tool that drops UserData', () => {
  const project = defaultProject();
  const { doc } = roundTrip(project, stripUserData);

  it('has nothing to restore, so maps nothing by itself', () => {
    expect(doc.stagewash).toBeUndefined();
    expect([...suggestChoices(doc, library).values()].every((c) => c.kind === 'skip')).toBe(true);
  });

  it('keeps every position and every beam when the types are mapped back by hand', () => {
    // What a user does in the import dialog: one choice per fixture type.
    const choices = new Map<string, TypeChoice>();
    for (const type of doc.types) {
      const original = project.fixtures.find(
        (f) => gdtfSpecFor(library.get(f.modelId)!).replace(/\.gdtf$/, '') === type.key,
      )!;
      choices.set(type.key, { kind: 'model', modelId: original.modelId, opticId: original.opticId });
    }
    const rig = buildRig(doc, choices, library, { offset: NO_OFFSET, restoreStagewash: true });
    expect(rig.fixtures).toHaveLength(project.fixtures.length);

    const before = new Map(project.structures.map((s) => [s.id, s]));
    const after = new Map(rig.structures.map((s) => [s.id, s]));
    for (const original of project.fixtures) {
      const f = rig.fixtures.find((x) => x.channel === original.channel)!;
      const p0 = resolvePosition(original, before.get(original.structureId));
      const p1 = resolvePosition(f, after.get(f.structureId));
      expect(length(sub(p0, p1))).toBeLessThan(1e-9);
      const d0 = normalise(resolveDirection(original, p0));
      const d1 = normalise(resolveDirection(f, p1));
      expect(dot(d0, d1)).toBeGreaterThan(1 - 1e-12);
      // Roll survives in the matrix: the backlight PARs' oval lens stays across the stage.
      expect(f.roll).toBeCloseTo(original.roll, 6);
    }

    // The hanging positions come back as the three bars they were.
    expect(rig.structures.map((s) => s.name).sort()).toEqual(project.structures.map((s) => s.name).sort());
  });

  it('solves to the same levels once gel and level are put back', () => {
    // Level and gel transmission are the two things only UserData carries.
    const choices = new Map<string, TypeChoice>(
      doc.types.map((type) => {
        const original = project.fixtures.find(
          (f) => gdtfSpecFor(library.get(f.modelId)!).replace(/\.gdtf$/, '') === type.key,
        )!;
        return [type.key, { kind: 'model', modelId: original.modelId, opticId: original.opticId }];
      }),
    );
    const rig = buildRig(doc, choices, library, { offset: NO_OFFSET, restoreStagewash: true });
    rig.fixtures = rig.fixtures.map((f) => {
      const original = project.fixtures.find((o) => o.channel === f.channel)!;
      return { ...f, level: original.level, transmission: original.transmission };
    });
    const back = applyImport(defaultProject(), rig);
    expect(maxRelativeDifference(solveGrid(project), solveGrid(back))).toBeLessThan(1e-6);
  });
});

describe('import offset', () => {
  it('moves fixtures, aims and structures together', () => {
    const project = defaultProject();
    const { doc } = roundTrip(project);
    const offset = { x: 1, y: -2, z: 0.5 };
    const rig = buildRig(doc, suggestChoices(doc, library), library, { offset, restoreStagewash: true });
    const structures = new Map(rig.structures.map((s) => [s.id, s]));
    const before = new Map(project.structures.map((s) => [s.id, s]));
    for (const original of project.fixtures) {
      const f = rig.fixtures.find((x) => x.id === original.id)!;
      const moved = sub(resolvePosition(f, structures.get(f.structureId)), resolvePosition(original, before.get(original.structureId)));
      expect(length(sub(moved, offset))).toBeLessThan(1e-9);
      expect(length(sub(sub(f.aim, original.aim), offset))).toBeLessThan(1e-9);
    }
  });
});

describe('a measured fixture travels inside the MVR', () => {
  it('carries the custom model and lands it in a project that never had it', async () => {
    const { readFileSync } = await import('node:fs');
    const { parseIes } = await import('../photometry/ies');
    const ies = parseIes(
      readFileSync(new URL('./fixtures/etc-s4-36-hpl750-115.ies', import.meta.url), 'latin1'),
    );
    const custom = {
      id: 'custom-s4-ies',
      manufacturer: 'ETC',
      name: 'S4 36 (IES)',
      kind: 'profile' as const,
      watts: 750,
      weightKg: 7.3,
      optics: [{ id: 'measured', label: 'As measured', photometrics: ies.photometrics }],
    };
    const project = defaultProject();
    project.customModels = [custom];
    project.fixtures = project.fixtures.map((f) =>
      f.modelId === 'etc-s4-36' ? { ...f, modelId: custom.id, opticId: 'measured' } : f,
    );

    const { doc } = roundTrip(project);
    // Imported into a fresh project, whose library has never seen the model.
    const rig = buildRig(doc, suggestChoices(doc, library), library, {
      offset: NO_OFFSET,
      restoreStagewash: true,
    });
    expect(rig.customModels.map((m) => m.id)).toEqual([custom.id]);
    expect(rig.customModels[0]!.optics[0]!.photometrics.provenance).toBe('measured');
    expect(rig.fixtures.filter((f) => f.modelId === custom.id)).toHaveLength(5);
    const back = applyImport(defaultProject(), rig);
    expect(maxRelativeDifference(solveGrid(project), solveGrid(back))).toBeLessThan(1e-6);
  });
});
