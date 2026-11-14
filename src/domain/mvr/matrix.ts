/**
 * MVR transforms.
 *
 * An MVR `<Matrix>` is `{u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{o1,o2,o3}`: right-handed,
 * Z-up, **millimetres**. `u`, `v` and `w` are where the object's local X, Y and
 * Z axes point in its parent's frame, and `o` is where its origin sits — i.e.
 * they are the *columns* of the rotation, not its rows. The spec only lists the
 * order; the column reading is confirmed by real files (see AGENTS.md §6c): in
 * the Capture demo show, side-lights stacked up a tower at x = −6.7 m only
 * point *at* the stage under this reading, and point away from it under the
 * other.
 *
 * Stagewash's own frame is also right-handed and Z-up, with +x toward the
 * audience's right and +y upstage — the same plan orientation a Vectorworks
 * light plot uses — so the mapping is a unit change, nothing else.
 */

import { cross, dot, length, normalise, scale, sub, vec } from '../geometry';
import type { Vec3 } from '../types';

export interface Transform {
  u: Vec3;
  v: Vec3;
  w: Vec3;
  /** Origin, millimetres. */
  o: Vec3;
}

export const MM_PER_M = 1000;

export const IDENTITY: Transform = {
  u: vec(1, 0, 0),
  v: vec(0, 1, 0),
  w: vec(0, 0, 1),
  o: vec(0, 0, 0),
};

/**
 * Parse an MVR matrix string. Missing or malformed → identity, which is what
 * the spec says a missing matrix means.
 */
export function parseMatrix(text: string | undefined): Transform {
  if (!text) return IDENTITY;
  const groups = text.match(/\{[^}]*\}/g);
  if (!groups || groups.length < 4) return IDENTITY;
  const rows = groups.slice(0, 4).map((g) =>
    g
      .slice(1, -1)
      .split(',')
      .map((s) => Number.parseFloat(s.trim())),
  );
  if (rows.some((r) => r.length < 3 || r.slice(0, 3).some((x) => !Number.isFinite(x)))) {
    return IDENTITY;
  }
  const v3 = (r: number[]): Vec3 => vec(r[0] as number, r[1] as number, r[2] as number);
  return { u: v3(rows[0]!), v: v3(rows[1]!), w: v3(rows[2]!), o: v3(rows[3]!) };
}

/**
 * Format a transform. Twelve significant digits keeps a millimetre position
 * exact to well under a micron across a 100 m venue, which is what the spec's
 * "sufficient decimal places to precisely round-trip" asks for.
 */
export function formatMatrix(t: Transform): string {
  const f = (x: number): string => {
    // Never write -0 or 1e-17 noise; both are legal and both look like bugs.
    const clean = Math.abs(x) < 1e-12 ? 0 : x;
    return String(Number(clean.toPrecision(12)));
  };
  const g = (p: Vec3): string => `{${f(p.x)},${f(p.y)},${f(p.z)}}`;
  return `${g(t.u)}${g(t.v)}${g(t.w)}${g(t.o)}`;
}

/** Apply the rotation part only (a direction). */
export const rotate = (t: Transform, d: Vec3): Vec3 =>
  vec(
    t.u.x * d.x + t.v.x * d.y + t.w.x * d.z,
    t.u.y * d.x + t.v.y * d.y + t.w.y * d.z,
    t.u.z * d.x + t.v.z * d.y + t.w.z * d.z,
  );

/** Apply the whole transform to a point (millimetres in, millimetres out). */
export const apply = (t: Transform, p: Vec3): Vec3 => {
  const r = rotate(t, p);
  return vec(r.x + t.o.x, r.y + t.o.y, r.z + t.o.z);
};

/** `parent ∘ local`: a child's transform expressed in its grandparent's frame. */
export function compose(parent: Transform, local: Transform): Transform {
  return {
    u: rotate(parent, local.u),
    v: rotate(parent, local.v),
    w: rotate(parent, local.w),
    o: apply(parent, local.o),
  };
}

/** Origin of a transform, in metres. */
export const originM = (t: Transform): Vec3 => scale(t.o, 1 / MM_PER_M);

/**
 * A rotation whose local −Z points along `beam` and whose local X is `right`.
 *
 * GDTF draws every fixture hanging, beam out of the bottom: "the beam geometry
 * emits its light into negative Z direction". So an MVR fixture's beam axis is
 * `−w`, and building `w = −beam` is what makes a receiver draw the light going
 * where stagewash sends it. `right` is the C = 0 axis of the photometry, so a
 * fixture's roll survives the trip too.
 */
export function beamTransform(beam: Vec3, right: Vec3, originMm: Vec3): Transform {
  const w = normalise(scale(beam, -1));
  // Re-orthogonalise: `right` arrives from fixtureFrame and is already
  // perpendicular, but a transform that is a hair off orthonormal is a thing
  // every receiver handles differently.
  const u = normalise(sub(right, scale(w, dot(right, w))));
  const v = cross(w, u);
  return { u, v, w, o: originMm };
}

/** True when the rotation part is orthonormal and right-handed, within `tol`. */
export function isRigidRotation(t: Transform, tol = 1e-6): boolean {
  const unit = (a: Vec3): boolean => Math.abs(length(a) - 1) < tol;
  const perp = (a: Vec3, b: Vec3): boolean => Math.abs(dot(a, b)) < tol;
  const handed = dot(cross(t.u, t.v), t.w) > 1 - tol;
  return unit(t.u) && unit(t.v) && unit(t.w) && perp(t.u, t.v) && perp(t.v, t.w) && perp(t.u, t.w) && handed;
}
