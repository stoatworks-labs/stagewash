/**
 * Everything geometric in this app quotes the **field** angle — 10% of peak —
 * and never the 50% beam angle.
 *
 * That distinction is not pedantry. On a Source Four 36° the beam angle is 27°
 * and the field angle 34°: a designer who spaces a wash so the *beam* angles
 * meet has laid the fixtures a fifth further apart than the light allows, and
 * the seam between two pools goes dark. The cone drawn in the viewport, the
 * footprint ring on the deck and "focus to cover" therefore all have to be the
 * field angle, or the picture is telling the designer a coverage story that the
 * solve does not agree with.
 *
 * The solve itself never touches either number — it integrates the whole
 * distribution — so these tests are about the angles the app *displays* and
 * *focuses* by, which is exactly where an angle convention can silently drift.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FIXTURE_LIBRARY } from '../../data/fixtures';
import { defaultProject } from '../../state/defaultProject';
import { angleAtFraction, beamAngleOf, fieldAngleOf } from '../photometry/distribution';
import { parseIes } from '../photometry/ies';
import { fieldAngleOfPhotometry, maxGammaOf, modelIndex, prepareRig } from '../rig';
import type { FixtureModel } from '../types';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function measuredS4(): FixtureModel {
  const photometrics = parseIes(
    readFileSync(join(FIXTURES, 'etc-s4-36-hpl750-115.ies'), 'latin1'),
  ).photometrics;

  return {
    id: 'measured-s4-36',
    manufacturer: 'ETC',
    name: 'Source Four 36° (imported)',
    kind: 'profile',
    watts: 750,
    weightKg: 7,
    optics: [{ id: 'main', label: '36°', photometrics }],
  };
}

describe('prepareRig reports the field angle, for measured fixtures as much as analytic ones', () => {
  it('takes a measured fixture to its true 10% angle, not a fraction of its cutoff', () => {
    const model = measuredS4();
    const optic = model.optics[0]!;
    const photometry = optic.photometrics.photometry;

    const project = defaultProject();
    project.customModels = [model];
    for (const fixture of project.fixtures) {
      fixture.modelId = model.id;
      fixture.opticId = optic.id;
    }

    const { fixtures } = prepareRig(project, modelIndex(FIXTURE_LIBRARY, project.customModels));
    expect(fixtures.length).toBeGreaterThan(0);

    const truth = angleAtFraction(photometry, 0.1);
    for (const prepared of fixtures) {
      expect(prepared.fieldAngle).toBeCloseTo(truth, 6);
    }

    // The shape of the old bug: two thirds of the last gamma carrying light is
    // not a field angle, and on this file it is several degrees out. Pinned so
    // that reintroducing the heuristic fails here rather than in someone's
    // plot.
    const heuristic = (maxGammaOf(photometry) * 2) / 3;
    expect(Math.abs(heuristic - truth)).toBeGreaterThan(1);
  });

  it('is the 10% angle and not the 50% one, which are far enough apart to matter', () => {
    const photometry = measuredS4().optics[0]!.photometrics.photometry;

    const field = angleAtFraction(photometry, 0.1);
    const beam = angleAtFraction(photometry, 0.5);

    // A real profile runs a beam:field ratio around 0.7–0.8. Spacing a wash on
    // the beam angle would leave roughly a quarter of the throw uncovered.
    expect(beam / field).toBeGreaterThan(0.6);
    expect(beam / field).toBeLessThan(0.9);
    expect(fieldAngleOfPhotometry(photometry, field)).toBeCloseTo(field, 6);
  });

  it('prefers the optic’s stored field angle to re-walking the table', () => {
    const photometrics = measuredS4().optics[0]!.photometrics;

    // `parseIes` already resolved it; `fieldAngleOfPhotometry` must agree with
    // what the importer wrote rather than quietly computing a second opinion.
    expect(photometrics.fieldAngle).toBeGreaterThan(0);
    expect(
      fieldAngleOfPhotometry(photometrics.photometry, photometrics.fieldAngle),
    ).toBe(photometrics.fieldAngle);
  });

  it('uses the closed form for an analytic beam, and it is the 10% angle', () => {
    const project = defaultProject();
    const { fixtures } = prepareRig(project, modelIndex(FIXTURE_LIBRARY, project.customModels));

    for (const prepared of fixtures) {
      if (prepared.photometry.kind !== 'analytic') continue;
      expect(prepared.fieldAngle).toBeCloseTo(fieldAngleOf(prepared.photometry), 9);
      expect(prepared.fieldAngle).toBeGreaterThan(beamAngleOf(prepared.photometry));
    }
  });

  it('carries a field angle for a fixture parked at zero, which the solve drops', () => {
    const project = defaultProject();
    const dark = project.fixtures[0]!;
    dark.level = 0;

    const { fixtures, fieldAngles } = prepareRig(
      project,
      modelIndex(FIXTURE_LIBRARY, project.customModels),
    );

    // Nothing to solve for it — but the viewport still draws its cone, so the
    // angle has to be there and has to be the fixture's own, not a nominal one.
    expect(fixtures.some((f) => f.id === dark.id)).toBe(false);
    expect(fieldAngles.get(dark.id)).toBeGreaterThan(0);
    expect(fieldAngles.size).toBe(project.fixtures.length);
  });
});
