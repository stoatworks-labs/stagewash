/**
 * Vector maths and the fixture frame. Pure, React-free, no allocations that
 * matter — the solver calls into here a few hundred thousand times per recompute
 * and takes scalars rather than objects on the hot path for that reason.
 */

import type { Frame, Vec3 } from './types';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export function normalise(a: Vec3): Vec3 {
  const len = length(a);
  // A zero vector has no direction; returning +z rather than NaN keeps a
  // degenerate fixture (aimed at itself) out of the solver's arithmetic.
  return len < 1e-12 ? vec(0, 0, 1) : scale(a, 1 / len);
}

export function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

// ---------------------------------------------------------------------------
// Pan / tilt
// ---------------------------------------------------------------------------

/**
 * Pan and tilt, in the convention documented on `RigFixture`:
 *
 * - pan 0 points straight **upstage** (+y), positive rotates toward +x
 *   (the audience's right).
 * - tilt 0 is horizontal, -90 is straight down, +90 straight up.
 *
 * This is the convention a crew uses when they say "pan it 15 left, tilt down
 * 40", and it is the one the report prints.
 */
export interface PanTilt {
  pan: number;
  tilt: number;
}

/** Unit beam-axis direction for a given pan/tilt, in world coordinates. */
export function directionFromPanTilt(pan: number, tilt: number): Vec3 {
  const p = pan * DEG;
  const t = tilt * DEG;
  const horiz = Math.cos(t);
  return vec(horiz * Math.sin(p), horiz * Math.cos(p), Math.sin(t));
}

/** Inverse of {@link directionFromPanTilt}. */
export function panTiltFromDirection(d: Vec3): PanTilt {
  const n = normalise(d);
  const pan = Math.atan2(n.x, n.y) * RAD;
  const tilt = Math.asin(clamp(n.z, -1, 1)) * RAD;
  return { pan, tilt };
}

/** Pan/tilt that points a fixture at `from` toward `at`. */
export function panTiltToAim(from: Vec3, at: Vec3): PanTilt {
  return panTiltFromDirection(sub(at, from));
}

// ---------------------------------------------------------------------------
// Fixture frame
// ---------------------------------------------------------------------------

/**
 * Build the orthonormal frame a photometric distribution is sampled in.
 *
 * `forward` is the beam axis (gamma = 0). `right` is the C = 0 axis: the
 * horizontal axis perpendicular to the beam, rolled by `roll` degrees about the
 * beam. When the beam is within a whisker of vertical, "horizontal
 * perpendicular" is undefined, so the world +y axis is used as the reference
 * instead of +z — without that, a fixture tilted to exactly -90° (a downlight,
 * which is extremely common) produces a degenerate frame and an asymmetric
 * fixture's distribution spins arbitrarily.
 */
export function fixtureFrame(direction: Vec3, roll: number): Frame {
  const forward = normalise(direction);
  const reference = Math.abs(forward.z) > 0.9999 ? vec(0, 1, 0) : vec(0, 0, 1);

  let right = normalise(cross(forward, reference));
  let up = normalise(cross(right, forward));

  if (roll !== 0) {
    const r = roll * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const rotatedRight = add(scale(right, c), scale(up, s));
    const rotatedUp = add(scale(up, c), scale(right, -s));
    right = rotatedRight;
    up = rotatedUp;
  }

  return { forward, right, up };
}

/**
 * Convert a world direction into the fixture's photometric (C, gamma) angles,
 * both in degrees.
 *
 * `direction` must point **from the fixture toward the point being lit** and
 * need not be normalised.
 */
export function toPhotometricAngles(
  frame: Frame,
  direction: Vec3,
): { c: number; gamma: number } {
  const d = normalise(direction);
  const alongBeam = clamp(dot(d, frame.forward), -1, 1);
  const gamma = Math.acos(alongBeam) * RAD;

  const x = dot(d, frame.right);
  const y = dot(d, frame.up);
  let c = Math.atan2(y, x) * RAD;
  if (c < 0) c += 360;

  return { c, gamma };
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

/** World position of a fixture `along` metres down a structure run. */
export function positionAlong(from: Vec3, to: Vec3, along: number): Vec3 {
  const span = sub(to, from);
  const len = length(span);
  if (len < 1e-9) return { ...from };
  return add(from, scale(span, clamp(along, 0, len) / len));
}

/** Length of a structure run, metres. */
export const runLength = (from: Vec3, to: Vec3): number => length(sub(from, to));

// ---------------------------------------------------------------------------
// Beam footprint
// ---------------------------------------------------------------------------

/**
 * Where the cone of half-angle `halfAngleDeg` about `direction` from `origin`
 * lands on the horizontal plane `z = planeZ`, as a polygon of `segments`
 * points.
 *
 * Returns an empty array when the cone does not close on the plane — a fixture
 * aimed at or above the horizon throws a hyperbola, not an ellipse, and drawing
 * the wrapped-around points produces a bowtie across the stage that looks like
 * a rendering bug. The caller draws nothing in that case, which is the truth:
 * that light misses the deck.
 */
export function beamFootprint(
  origin: Vec3,
  direction: Vec3,
  halfAngleDeg: number,
  planeZ: number,
  segments = 48,
): Vec3[] {
  const frame = fixtureFrame(direction, 0);
  const half = clamp(halfAngleDeg, 0.1, 89.9) * DEG;
  const tanHalf = Math.tan(half);
  const points: Vec3[] = [];

  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const rim = normalise(
      add(
        frame.forward,
        add(scale(frame.right, Math.cos(a) * tanHalf), scale(frame.up, Math.sin(a) * tanHalf)),
      ),
    );
    // Ray/plane intersection. rim.z >= 0 means this edge of the cone never
    // comes down.
    if (rim.z > -1e-6) return [];
    const t = (planeZ - origin.z) / rim.z;
    if (t <= 0) return [];
    points.push(add(origin, scale(rim, t)));
  }

  return points;
}
