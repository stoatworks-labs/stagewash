/**
 * The rig the app opens with.
 *
 * Not empty, on purpose. A tool like this is unintelligible from a blank stage —
 * you cannot tell what a heatmap means until you have seen one — so the default
 * is a small, plausible, deliberately *imperfect* rig: a three-colour-wash FOH
 * bar and an overhead bar over a 10 × 6 m stage. It has visible unevenness at
 * the edges, which is the thing the app exists to show you.
 */

import { runLength } from '../domain/geometry';
import { spacingAlong } from '../domain/rig';
import type { Project, RigFixture, Structure, Vec3 } from '../domain/types';

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const FOH: Structure = {
  id: 'foh',
  name: 'FOH bar',
  kind: 'truss',
  from: vec(-6, -7, 6.5),
  to: vec(6, -7, 6.5),
  sizeM: 0.29,
  swlKg: 250,
  colour: '#8fb6d8',
};

const OVERHEAD: Structure = {
  id: 'lx1',
  name: 'LX1',
  kind: 'truss',
  from: vec(-6, 2, 6),
  to: vec(6, 2, 6),
  sizeM: 0.29,
  swlKg: 250,
  colour: '#8fb6d8',
};

const BACK: Structure = {
  id: 'lx2',
  name: 'LX2 (backlight)',
  kind: 'truss',
  from: vec(-5, 6.5, 5.5),
  to: vec(5, 6.5, 5.5),
  sizeM: 0.29,
  swlKg: 250,
  colour: '#8fb6d8',
};

/** Build a fixture with the fields most calls do not care about filled in. */
function fixture(options: {
  id: string;
  channel: string;
  modelId: string;
  opticId: string;
  structureId: string;
  along: number;
  aim: Vec3;
  zoom?: number;
  level?: number;
  transmission?: number;
  gelName?: string;
  roll?: number;
}): RigFixture {
  return {
    id: options.id,
    channel: options.channel,
    modelId: options.modelId,
    opticId: options.opticId,
    structureId: options.structureId,
    along: options.along,
    position: vec(0, 0, 0), // resolved from the structure on load
    focusMode: 'aim',
    aim: options.aim,
    pan: 0,
    tilt: -45,
    roll: options.roll ?? 0,
    ...(options.zoom !== undefined ? { zoom: options.zoom } : {}),
    level: options.level ?? 1,
    transmission: options.transmission ?? 1,
    ...(options.gelName !== undefined ? { gelName: options.gelName } : {}),
    enabled: true,
  };
}

/**
 * A five-and-five wash: FOH profiles at their flood end covering the downstage
 * acting area, overhead 36°s covering upstage, and four backlight PARs.
 *
 * The aims are laid out the way a designer would actually lay them out — a row
 * of overlapping pools per depth zone — because a default rig whose beams do
 * not overlap reports a min:avg around 0.01, and a uniformity figure that bad
 * reads as "this tool is broken" rather than "this rig needs work". It is still
 * deliberately imperfect: the corners fall away and the two zones meet
 * unevenly, which is exactly what the heatmap is for.
 */
function buildFixtures(): RigFixture[] {
  const fixtures: RigFixture[] = [];

  // Aim x positions spread across most of the stage width, downstage zone.
  const fohSpots = spacingAlong(FOH, 5, 1.2);
  const fohAimX = [-4, -2, 0, 2, 4];
  fohSpots.forEach((along, i) => {
    fixtures.push(
      fixture({
        id: `foh-${i + 1}`,
        channel: `${i + 1}`,
        modelId: 'etc-s4-zoom-15-30',
        opticId: 'z30',
        structureId: FOH.id,
        along,
        // Aimed at head height, which is what a front light is for.
        aim: vec(fohAimX[i] as number, 1.8, 1.5),
      }),
    );
  });

  const lxSpots = spacingAlong(OVERHEAD, 5, 1.2);
  const lxAimX = [-4, -2, 0, 2, 4];
  lxSpots.forEach((along, i) => {
    fixtures.push(
      fixture({
        id: `lx1-${i + 1}`,
        channel: `${11 + i}`,
        modelId: 'etc-s4-36',
        opticId: '36',
        structureId: OVERHEAD.id,
        along,
        aim: vec(lxAimX[i] as number, 4.4, 1.5),
      }),
    );
  });

  const backSpots = spacingAlong(BACK, 4, 1.2);
  backSpots.forEach((along, i) => {
    fixtures.push(
      fixture({
        id: `lx2-${i + 1}`,
        channel: `${21 + i}`,
        modelId: 'etc-s4-par-mcm',
        opticId: 'mfl',
        structureId: BACK.id,
        along,
        aim: vec(-3.6 + i * 2.4, 3, 1.2),
        // The MFL lens is oval; rolled 90° its wide axis runs across the stage.
        roll: 90,
        transmission: 0.35,
        gelName: 'Deep blue (nominal 35% transmission)',
      }),
    );
  });

  return fixtures;
}

export function defaultProject(): Project {
  return {
    version: 1,
    name: 'Untitled rig',
    stage: { widthM: 10, depthM: 6, heightM: 0 },
    // Head height, not deck level.
    //
    // A front light aimed at a performer's face crosses the *deck* well
    // upstage of where it crosses head height — a fixture at 6.5 m aimed at
    // 1.5 m carries on another 2.5 m before it reaches the floor. Measuring at
    // the deck therefore shows the downstage edge dark even when the people
    // standing on it are lit perfectly well, which is true but is not the
    // question anyone is asking first. 1.5 m is where the faces are.
    plane: { orientation: 'horizontal', heightM: 1.5, resolutionM: 0.2 },
    targets: {
      targetLux: 500,
      darkFraction: 0.5,
      hotMultiple: 2,
      minUniformity: 0.4,
    },
    structures: [FOH, OVERHEAD, BACK],
    fixtures: buildFixtures(),
    customModels: [],
  };
}

/** An empty stage, for "New project". */
export function emptyProject(): Project {
  const base = defaultProject();
  return { ...base, name: 'Untitled rig', fixtures: [], structures: [FOH, OVERHEAD, BACK] };
}

/** Longest structure run in the project, for sizing the "along" sliders. */
export const structureLength = (structure: Structure): number =>
  runLength(structure.from, structure.to);
