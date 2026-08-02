/**
 * Turning the editable rig document into something the solver can evaluate.
 *
 * The document stores what the *user* set — a fixture is on this truss, this far
 * along it, aimed at that spot. The solver needs a world position, an
 * orthonormal frame and a distribution. This module is the one place that
 * conversion happens, so the 3D view, the report and the solver can never
 * disagree about where a light is pointing.
 */

import {
  directionFromPanTilt,
  fixtureFrame,
  length,
  panTiltToAim,
  positionAlong,
  runLength,
  sub,
} from './geometry';
import { fieldAngleOf, scaleZoom } from './photometry/distribution';
import type {
  FixtureModel,
  FixtureOptic,
  Frame,
  Photometry,
  Project,
  RigFixture,
  Structure,
  Vec3,
} from './types';
import { MOVING_KINDS, ZOOMABLE_KINDS } from './types';

/** A fixture reduced to exactly what the illuminance solve needs. */
export interface PreparedFixture {
  id: string;
  channel: string;
  position: Vec3;
  frame: Frame;
  photometry: Photometry;
  /** level × gel transmission, folded into one multiplier. */
  gain: number;
  /**
   * Beyond this gamma the fixture emits nothing, so the solver can reject a
   * point with a single dot product instead of a table lookup. This is the
   * difference between a solve that keeps up with a drag and one that does not.
   */
  maxGamma: number;
  /** True when the distribution does not vary with C, so the solver skips atan2. */
  rotationallySymmetric: boolean;
}

export interface RigIssue {
  fixtureId?: string;
  structureId?: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PreparedRig {
  fixtures: PreparedFixture[];
  issues: RigIssue[];
}

/** Every model the project can use: the built-in library plus its own customs. */
export function modelIndex(
  library: FixtureModel[],
  custom: FixtureModel[],
): Map<string, FixtureModel> {
  const map = new Map<string, FixtureModel>();
  for (const m of library) map.set(m.id, m);
  // Project-local models win, so a user can override a library entry with a
  // measured file of their own without renaming anything.
  for (const m of custom) map.set(m.id, m);
  return map;
}

export function findOptic(model: FixtureModel, opticId: string): FixtureOptic | undefined {
  return model.optics.find((o) => o.id === opticId) ?? model.optics[0];
}

/** World position of a fixture, from its structure and its distance along it. */
export function resolvePosition(fixture: RigFixture, structure: Structure | undefined): Vec3 {
  if (!structure) return fixture.position;
  return positionAlong(structure.from, structure.to, fixture.along);
}

/** Unit vector along the beam axis, whichever way the user chose to focus. */
export function resolveDirection(fixture: RigFixture, position: Vec3): Vec3 {
  if (fixture.focusMode === 'aim') {
    const toAim = sub(fixture.aim, position);
    // Aiming a fixture at its own position has no direction. Point it down —
    // the same thing a real one does when you let go of it.
    if (length(toAim) < 1e-6) return { x: 0, y: 0, z: -1 };
    return toAim;
  }
  return directionFromPanTilt(fixture.pan, fixture.tilt);
}

/**
 * The distribution this fixture actually has right now: the optic's stored
 * photometry, zoomed if the fixture is a zoom and the user has moved it.
 *
 * A **measured** distribution is never stretched. It describes one zoom
 * position, and pretending it describes another would launder an estimate as a
 * measurement — the library carries a separate optic per measured step instead.
 * `zoomIsExact` reports which happened so the UI can say so.
 */
export function resolvePhotometry(
  optic: FixtureOptic,
  fixture: RigFixture,
): { photometry: Photometry; zoomIsExact: boolean } {
  const stored = optic.photometrics.photometry;
  const wanted = fixture.zoom;

  if (wanted === undefined || optic.zoomMin === undefined) {
    return { photometry: stored, zoomIsExact: true };
  }
  if (stored.kind !== 'analytic') {
    return { photometry: stored, zoomIsExact: false };
  }
  if (Math.abs(fieldAngleOf(stored) - wanted) < 0.01) {
    return { photometry: stored, zoomIsExact: true };
  }
  return { photometry: scaleZoom(stored, wanted), zoomIsExact: true };
}

/** Largest gamma at which a distribution still emits, degrees. */
export function maxGammaOf(p: Photometry): number {
  if (p.kind === 'analytic') return p.cutoffGamma;
  const last = p.gammaAngles[p.gammaAngles.length - 1];
  return last ?? 180;
}

function isRotationallySymmetric(p: Photometry): boolean {
  return p.kind === 'analytic' ? p.k === p.kCross : p.cAngles.length <= 1;
}

/**
 * Prepare the whole rig for solving, and collect everything wrong with it on
 * the way past.
 *
 * The issues are the point as much as the fixtures are: a fixture referencing a
 * model that no longer exists, a moving head asked to tilt further than it can,
 * a stand racked past its rated height, or a truss carrying more than its SWL
 * are all things you want to hear about at the desk rather than in the venue.
 */
export function prepareRig(
  project: Project,
  models: Map<string, FixtureModel>,
): PreparedRig {
  const structures = new Map(project.structures.map((s) => [s.id, s]));
  const fixtures: PreparedFixture[] = [];
  const issues: RigIssue[] = [];
  const loadByStructure = new Map<string, number>();

  for (const fixture of project.fixtures) {
    const model = models.get(fixture.modelId);
    if (!model) {
      issues.push({
        fixtureId: fixture.id,
        severity: 'error',
        message: `Channel ${fixture.channel} uses fixture model "${fixture.modelId}", which is not in the library or this project.`,
      });
      continue;
    }

    const structure = structures.get(fixture.structureId);
    if (!structure) {
      issues.push({
        fixtureId: fixture.id,
        severity: 'error',
        message: `Channel ${fixture.channel} is hung on a structure that no longer exists.`,
      });
      continue;
    }

    loadByStructure.set(
      structure.id,
      (loadByStructure.get(structure.id) ?? 0) + model.weightKg,
    );

    const optic = findOptic(model, fixture.opticId);
    if (!optic) {
      issues.push({
        fixtureId: fixture.id,
        severity: 'error',
        message: `Channel ${fixture.channel} has no usable optic.`,
      });
      continue;
    }

    const position = resolvePosition(fixture, structure);
    const direction = resolveDirection(fixture, position);
    const { photometry, zoomIsExact } = resolvePhotometry(optic, fixture);

    if (!zoomIsExact) {
      issues.push({
        fixtureId: fixture.id,
        severity: 'warning',
        message: `Channel ${fixture.channel} has measured photometry for ${optic.label} and cannot be zoomed away from it. It is calculated at its measured angle.`,
      });
    }

    checkFocusReach(fixture, model, position, issues);
    checkStructure(structure, fixture, issues);

    if (!fixture.enabled) continue;

    const gain = fixture.level * fixture.transmission;
    if (gain <= 0) continue;

    fixtures.push({
      id: fixture.id,
      channel: fixture.channel,
      position,
      frame: fixtureFrame(direction, fixture.roll),
      photometry,
      gain,
      maxGamma: maxGammaOf(photometry),
      rotationallySymmetric: isRotationallySymmetric(photometry),
    });
  }

  for (const [structureId, load] of loadByStructure) {
    const structure = structures.get(structureId);
    if (structure?.swlKg !== undefined && load > structure.swlKg) {
      issues.push({
        structureId,
        severity: 'warning',
        message: `${structure.name} carries ${load.toFixed(1)} kg of fixtures against a stated SWL of ${structure.swlKg} kg. This counts fixture weight only — not clamps, cable, or the structure itself.`,
      });
    }
  }

  return { fixtures, issues };
}

/** Can this fixture physically point where it has been asked to point? */
function checkFocusReach(
  fixture: RigFixture,
  model: FixtureModel,
  position: Vec3,
  issues: RigIssue[],
): void {
  if (!MOVING_KINDS.has(model.kind)) return;
  if (fixture.focusMode !== 'aim') return;

  const { pan, tilt } = panTiltToAim(position, fixture.aim);

  if (model.panRange !== undefined && Math.abs(pan) > model.panRange / 2) {
    issues.push({
      fixtureId: fixture.id,
      severity: 'warning',
      message: `Channel ${fixture.channel} needs ${pan.toFixed(0)}° of pan to make its focus, past its ${model.panRange}° range. Rotate the fixture on the bar or move it.`,
    });
  }

  // Tilt is quoted as a total range about horizontal, so a 270° head reaches
  // 135° either side.
  if (model.tiltRange !== undefined && Math.abs(tilt) > model.tiltRange / 2) {
    issues.push({
      fixtureId: fixture.id,
      severity: 'warning',
      message: `Channel ${fixture.channel} needs ${tilt.toFixed(0)}° of tilt to make its focus, past its ${model.tiltRange}° range.`,
    });
  }
}

function checkStructure(structure: Structure, fixture: RigFixture, issues: RigIssue[]): void {
  if (structure.kind !== 'stand') return;
  if (structure.maxHeightM === undefined) return;

  const height = Math.max(structure.from.z, structure.to.z);
  if (height > structure.maxHeightM + 1e-6) {
    issues.push({
      fixtureId: fixture.id,
      structureId: structure.id,
      severity: 'error',
      message: `${structure.name} is set to ${height.toFixed(2)} m, above its rated maximum of ${structure.maxHeightM.toFixed(2)} m.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

/** Spread `count` fixtures evenly along a structure, inset from both ends. */
export function spacingAlong(structure: Structure, count: number, insetM = 0.5): number[] {
  const span = runLength(structure.from, structure.to);
  if (count <= 0) return [];
  if (count === 1) return [span / 2];

  const usable = Math.max(span - insetM * 2, 0);
  return Array.from({ length: count }, (_, i) => insetM + (usable * i) / (count - 1));
}

/**
 * Field angle that just covers a circle of radius `radiusM` at the distance
 * from `position` to `aim`. Used by "focus to cover", which is the first thing
 * anyone wants after dropping a fixture on a bar.
 */
export function fieldAngleToCover(position: Vec3, aim: Vec3, radiusM: number): number {
  const distance = length(sub(aim, position));
  if (distance < 1e-6) return 0;
  return 2 * Math.atan2(radiusM, distance) * (180 / Math.PI);
}

/** Clamp a requested zoom to what the optic can actually do. */
export function clampZoom(optic: FixtureOptic, wanted: number): number {
  if (optic.zoomMin === undefined || optic.zoomMax === undefined) return wanted;
  return Math.min(Math.max(wanted, optic.zoomMin), optic.zoomMax);
}

export function isZoomable(model: FixtureModel, optic: FixtureOptic): boolean {
  return ZOOMABLE_KINDS.has(model.kind) && optic.zoomMin !== undefined;
}
