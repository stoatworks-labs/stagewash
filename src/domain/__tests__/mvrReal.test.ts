import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FIXTURE_LIBRARY } from '../../data/fixtures';
import { length, normalise, sub } from '../geometry';
import { integrateFlux } from '../photometry/distribution';
import { modelIndex, resolveDirection, resolvePosition } from '../rig';
import { buildRig, modelFromGdtf, readMvr, suggestChoices, type TypeChoice } from '../mvr/importRig';
import { originM, rotate } from '../mvr/matrix';

/**
 * The MVR reader, against **real files written by other applications**.
 *
 * From the test corpus of `open-stage/python-mvr` (MIT), an independent MVR
 * implementation: one written by Vectorworks, one by Capture, one by
 * BlenderDMX. The Capture and Vectorworks files are trimmed to their scene
 * description and GDTFs — the dropped entries are 3D meshes stagewash never
 * reads — and `fixtures/README.md` records exactly what was removed.
 */

const load = (name: string) =>
  readMvr(new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));

const models = modelIndex(FIXTURE_LIBRARY, []);
const NO_OFFSET = { offset: { x: 0, y: 0, z: 0 }, restoreStagewash: true };

/** Map every type in a document to one library optic, so structure inference can be checked. */
const allAs = (doc: ReturnType<typeof readMvr>, modelId: string, opticId: string) =>
  new Map<string, TypeChoice>(doc.types.map((t) => [t.key, { kind: 'model', modelId, opticId }]));

describe('BlenderDMX: one fixture with a real GDTF beam', () => {
  const doc = load('mvr-blenderdmx-basic-fixture.mvr');

  it('reads the fixture at its position, in metres, beam straight down', () => {
    expect(doc.scene.fixtures).toHaveLength(1);
    const f = doc.scene.fixtures[0]!;
    expect(originM(f.transform)).toEqual({ x: 5, y: 5, z: 5 });
    // Identity matrix: GDTF hangs every fixture with its beam along local −Z.
    expect(rotate(f.transform, { x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('reads the beam out of the embedded GDTF and offers it as the choice', () => {
    const type = doc.types[0]!;
    expect(type.gdtf?.file).toBe('LED PAR 64 RGBW.gdtf');
    const beam = type.gdtf!.summary.beams[0]!;
    expect(beam).toMatchObject({ beamAngle: 60, fieldAngle: 90, luminousFlux: 7000, lampType: 'LED', placeholder: false });
    expect(type.gdtfBeamProblem).toBeUndefined();
    expect(suggestChoices(doc, models).get(type.key)).toEqual({ kind: 'gdtf' });
  });

  it('turns that beam into an estimate that conserves the stated flux and says what it is', () => {
    const model = modelFromGdtf(doc.types[0]!)!;
    const p = model.optics[0]!.photometrics;
    expect(p.provenance).toBe('estimated');
    expect(p.source).toMatch(/GDTF beam data/);
    expect(p.source).toMatch(/not photometry/);
    expect(p.fieldAngle).toBeCloseTo(90, 0);
    expect(p.beamAngle).toBeCloseTo(60, 0);
    // 7000 lm taken as the fixture's whole output, as an LED datasheet's is.
    expect(integrateFlux(p.photometry) / 7000).toBeCloseTo(1, 2);
  });

  it('imports as an angles-mode downlight on a bar through it', () => {
    const rig = buildRig(doc, suggestChoices(doc, models), models, NO_OFFSET);
    expect(rig.fixtures).toHaveLength(1);
    const f = rig.fixtures[0]!;
    expect(f.focusMode).toBe('angles');
    expect(f.tilt).toBeCloseTo(-90, 9);
    expect(f.pan).toBe(0);
    expect(rig.customModels).toHaveLength(1);
    const s = rig.structures.find((x) => x.id === f.structureId);
    expect(resolvePosition(f, s)).toEqual({ x: 5, y: 5, z: 5 });
    expect(rig.notes.join(' ')).toMatch(/estimated from its GDTF beam figures/);
  });
});

describe('Capture: 76 fixtures, stub GDTFs, no focus points', () => {
  const doc = load('mvr-capture-demo-show-trimmed.mvr');

  it('finds every fixture and all five types', () => {
    expect(doc.scene.verMajor).toBe(1);
    expect(doc.scene.verMinor).toBe(4);
    expect(doc.scene.fixtures).toHaveLength(76);
    expect(doc.types.map((t) => t.count).reduce((a, b) => a + b, 0)).toBe(76);
    expect(doc.types).toHaveLength(5);
    expect(doc.archive.gdtfErrors.size).toBe(0);
  });

  it('says plainly that Capture’s GDTFs carry no beam, and maps nothing by default', () => {
    for (const type of doc.types) {
      expect(type.gdtf).toBeDefined();
      expect(type.gdtf!.summary.beams).toHaveLength(0);
      expect(type.gdtfBeamProblem).toMatch(/no beam geometry/);
    }
    const choices = suggestChoices(doc, models);
    expect([...choices.values()].every((c) => c.kind === 'skip')).toBe(true);
    const rig = buildRig(doc, choices, models, NO_OFFSET);
    expect(rig.fixtures).toHaveLength(0);
    expect(rig.notes.join(' ')).toMatch(/left out: no fixture model was chosen/);
  });

  it('reads the matrix as columns: tower side-lights point at the stage, floor units at the cyc', () => {
    // Read u, v, w as the columns of the rotation (the images of the local
    // axes) and the rig makes sense; read them as rows and it is nonsense.
    // This is the evidence for the convention in matrix.ts — the spec only
    // gives the order.
    //
    // Two towers at x ≈ ±6.7 m carry ten fixtures with their beams
    // horizontal: under the column reading every one points in toward the
    // centre line, under the row reading every one points out into the wings.
    const towers = doc.scene.fixtures.filter((f) => f.layer.name === 'Truss Lights');
    expect(towers).toHaveLength(10);
    for (const f of towers) {
      const beam = rotate(f.transform, { x: 0, y: 0, z: -1 });
      expect(Math.abs(beam.z)).toBeLessThan(1e-3);
      expect(Math.sign(beam.x)).toBe(-Math.sign(originM(f.transform).x));
    }
    // Eight ADB ALC4 cyc units in a row on the deck: upstage and up, at a backdrop.
    const floor = doc.scene.fixtures.filter((f) => f.layer.name === 'Floor Lights');
    expect(floor).toHaveLength(8);
    for (const f of floor) {
      const beam = rotate(f.transform, { x: 0, y: 0, z: -1 });
      expect(beam.y).toBeGreaterThan(0.8);
      expect(beam.z).toBeGreaterThan(0.4);
    }
  });

  it('hangs every fixture on a straight run without moving it more than the snap tolerance', () => {
    const rig = buildRig(doc, allAs(doc, 'etc-s4-36', '36'), models, NO_OFFSET);
    expect(rig.fixtures).toHaveLength(76);
    const structures = new Map(rig.structures.map((s) => [s.id, s]));
    for (const f of rig.fixtures) {
      const placed = resolvePosition(f, structures.get(f.structureId));
      expect(length(sub(placed, f.position))).toBeLessThan(0.05);
    }
    // No two structures called the same thing because Capture left groups unnamed.
    const names = rig.structures.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('points an un-focused fixture where its body points', () => {
    const rig = buildRig(doc, allAs(doc, 'etc-s4-36', '36'), models, NO_OFFSET);
    const structures = new Map(rig.structures.map((s) => [s.id, s]));
    for (const f of rig.fixtures) {
      expect(f.focusMode).toBe('angles');
      const mvr = doc.scene.fixtures.find((m) => `mvr-${m.uuid}` === f.id)!;
      // Capture's rotations are a hair off unit length (1.00000095); compare directions.
      const body = normalise(rotate(mvr.transform, { x: 0, y: 0, z: -1 }));
      const dir = resolveDirection(f, resolvePosition(f, structures.get(f.structureId)));
      expect(dir.x).toBeCloseTo(body.x, 6);
      expect(dir.y).toBeCloseTo(body.y, 6);
      expect(dir.z).toBeCloseTo(body.z, 6);
    }
  });
});

describe('Vectorworks: 72 focused fixtures, placeholder GDTF beam', () => {
  const doc = load('mvr-vectorworks-scene-objects-trimmed.mvr');

  it('finds a GDTF that GDTFSpec names without its .gdtf extension', () => {
    expect(doc.scene.fixtures[0]!.gdtfSpec).toBe('Custom@Light Instr Light Source Pendant 44deg');
    expect(doc.types).toHaveLength(1);
    expect(doc.types[0]!.gdtf?.file).toBe('Custom@Light Instr Light Source Pendant 44deg.gdtf');
  });

  it('refuses the GDTF’s beam: it is the format’s defaults, not data', () => {
    // A fixture called "44deg" whose file says 25° beam and 25° field and
    // 10,000 lm — every one of them the spec default.
    const type = doc.types[0]!;
    expect(type.gdtf!.summary.beams[0]!.placeholder).toBe(true);
    expect(type.gdtfBeamProblem).toMatch(/default beam/);
    expect(modelFromGdtf(type)).toBeUndefined();
    expect(suggestChoices(doc, models).get(type.key)).toEqual({ kind: 'skip' });
  });

  it('aims every fixture at its focus point, and moves none of them', () => {
    expect(doc.scene.focusPoints.size).toBe(72);
    const rig = buildRig(doc, allAs(doc, 'etc-s4-36', '36'), models, NO_OFFSET);
    expect(rig.fixtures).toHaveLength(72);
    const structures = new Map(rig.structures.map((s) => [s.id, s]));
    for (const f of rig.fixtures) {
      const mvr = doc.scene.fixtures.find((m) => `mvr-${m.uuid}` === f.id)!;
      const fp = doc.scene.focusPoints.get(mvr.focus!)!;
      expect(f.focusMode).toBe('aim');
      expect(length(sub(f.aim, originM(fp.transform)))).toBeLessThan(1e-9);
      expect(length(sub(resolvePosition(f, structures.get(f.structureId)), originM(mvr.transform)))).toBeLessThan(1e-9);
    }
  });

  it('numbers fixtures whose FixtureID is empty', () => {
    const rig = buildRig(doc, allAs(doc, 'etc-s4-36', '36'), models, NO_OFFSET);
    const channels = rig.fixtures.map((f) => f.channel);
    expect(new Set(channels).size).toBe(72);
    expect(channels[0]).toBe('1');
  });
});
