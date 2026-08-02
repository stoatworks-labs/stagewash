/**
 * The whole data model. No React in here, ever. No side effects, no I/O.
 *
 * ## Coordinate system
 *
 * Right-handed, metres, origin at the **centre line of the downstage edge, at
 * deck level**:
 *
 * - `x` — across the stage, positive toward the **audience's right** (stage left).
 * - `y` — positive **upstage**, away from the audience.
 * - `z` — positive **up**.
 *
 * So the audience sits at negative `y`, and a fixture on an FOH bar is at
 * `y < 0`, `z ≈ 6`. This is the same handedness as ArrayCalc's plot, and it is
 * chosen so that a plan view is the natural `x`/`y` plane.
 *
 * ## Photometric coordinate system
 *
 * Distributions are stored and sampled in the CIE **C-γ** system (IES "Type C"),
 * which is what every entertainment-fixture photometric file uses:
 *
 * - `gamma` — angle from the beam axis, 0° dead centre of the beam, 180° directly
 *   behind the fixture.
 * - `c` — azimuth around the beam axis, 0..360°.
 *
 * `c = 0` lies along the fixture's local **right** axis (see `fixtureFrame`), and
 * the fixture's `roll` rotates the distribution about the beam axis. For a
 * rotationally symmetric fixture — most of them — `c` is irrelevant. It matters
 * for cyc units, battens and anything with a shaped or asymmetric lens, and roll
 * is how you orient those.
 *
 * ## Units
 *
 * SI throughout the domain: metres, candela, lumens, lux, degrees for angles
 * (degrees rather than radians because every photometric file and every fixture
 * datasheet is in degrees, and converting at the edges was a bug farm). Display
 * conversion to feet and footcandles happens in the UI, never in here.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a number came from. Every library fixture carries one, and the UI shows
 * it, because a lux figure computed from a guess is worth nothing and the user
 * must be able to tell which is which.
 *
 * - `measured`   — read from a manufacturer photometric file (IES/LDT) shipped
 *                  with the fixture or downloaded from the manufacturer.
 * - `published`  — transcribed from a manufacturer datasheet's photometric table
 *                  (centre-beam candela at a stated distance, beam/field angles).
 * - `estimated`  — synthesised by `photometry/estimator.ts` from fixture type,
 *                  lamp output and beam angles. Indicative only.
 */
export type Provenance = 'measured' | 'published' | 'estimated';

export interface Sourced {
  provenance: Provenance;
  /** Human-readable citation: document title, revision, date, or file name. */
  source: string;
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** An orthonormal basis for a fixture. `forward` is the beam axis (gamma = 0). */
export interface Frame {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

// ---------------------------------------------------------------------------
// Photometry
// ---------------------------------------------------------------------------

/**
 * A luminous intensity distribution, as plain structured-cloneable data so it
 * can be posted to the solver worker. Sampled by `intensityAt` in
 * `photometry/distribution.ts` — there are deliberately no methods here.
 */
export type Photometry = TabulatedPhotometry | AnalyticPhotometry;

/**
 * A measured distribution: the candela grid straight out of an IES or EULUMDAT
 * file, interpolated bilinearly.
 */
export interface TabulatedPhotometry {
  kind: 'tabulated';
  /** Ascending gamma angles in degrees, typically 0..90 or 0..180. */
  gammaAngles: number[];
  /**
   * Ascending C angles in degrees. A single entry means rotationally symmetric;
   * `[0, 90]` and `[0, 90, 180, 270]` are the quarter/half symmetries that IES
   * files use, and `expandSymmetry` in the parser has already resolved those to
   * an explicit 0..360 set, so this is always the literal sampled set.
   */
  cAngles: number[];
  /**
   * Candela, indexed `[cIndex * gammaAngles.length + gammaIndex]`. Flat rather
   * than nested so it survives a structured clone cheaply and can become a
   * Float64Array if it ever needs to.
   */
  candela: number[];
}

/**
 * A synthesised distribution: a super-Gaussian fitted through the beam angle
 * (50% of peak) and field angle (10% of peak). See `photometry/estimator.ts`
 * for the fit and why this shape.
 *
 * `intensity(gamma) = peakCandela * exp(-k * gammaEff^n)`
 *
 * where `gammaEff` folds an elliptical beam's two half-angles into one
 * equivalent angle, so a symmetric fixture and an asymmetric one share a code
 * path.
 */
export interface AnalyticPhotometry {
  kind: 'analytic';
  peakCandela: number;
  /** Exponent of the super-Gaussian. ~2 for a real optic, i.e. Gaussian. */
  n: number;
  /** Decay constant along the C = 0 axis, in units of degrees^-n. */
  k: number;
  /**
   * Decay constant along the C = 90 axis. Equal to `k` for a round beam;
   * different for a cyc unit or a batten, whose beam is an ellipse.
   */
  kCross: number;
  /** Hard cutoff in degrees from the axis; beyond this the optic emits nothing. */
  cutoffGamma: number;
}

/** Everything the app knows about how one model of fixture emits light. */
export interface FixturePhotometrics extends Sourced {
  photometry: Photometry;
  /** Total flux out of the lens, lumens. Derived, not authoritative. */
  outputLumens: number;
  /** Full angle in degrees where intensity is 50% of peak. */
  beamAngle: number;
  /** Full angle in degrees where intensity is 10% of peak. */
  fieldAngle: number;
  peakCandela: number;
}

// ---------------------------------------------------------------------------
// Fixture library
// ---------------------------------------------------------------------------

export type FixtureKind =
  | 'profile' // ellipsoidal / leko
  | 'fresnel'
  | 'pc' // prism convex
  | 'par'
  | 'wash' // LED wash / flood
  | 'cyc' // asymmetric cyc or groundrow unit
  | 'batten'
  | 'movingSpot'
  | 'movingWash'
  | 'beam';

/** Fixtures whose beam angle the operator can change on the fixture itself. */
export const ZOOMABLE_KINDS: ReadonlySet<FixtureKind> = new Set<FixtureKind>([
  'fresnel',
  'pc',
  'wash',
  'movingSpot',
  'movingWash',
  'beam',
]);

export const MOVING_KINDS: ReadonlySet<FixtureKind> = new Set<FixtureKind>([
  'movingSpot',
  'movingWash',
  'beam',
]);

export interface LampSpec extends Sourced {
  id: string;
  name: string;
  /** Bare lamp flux, lumens. */
  lumens: number;
  watts: number;
  /** Correlated colour temperature, kelvin. Display only — not used in maths. */
  cct: number;
}

/**
 * A model of fixture in the library. This is a *type*, not an instance hung on
 * a truss — that is `RigFixture`.
 */
export interface FixtureModel {
  id: string;
  manufacturer: string;
  name: string;
  kind: FixtureKind;
  /**
   * One entry per selectable optical configuration: a lens tube on a profile, a
   * zoom position on a fresnel, a zoom step on a moving head. Always at least
   * one. The first is the default.
   */
  optics: FixtureOptic[];
  /** Lamp id from the lamp table, when the fixture takes a separate lamp. */
  lampId?: string;
  watts: number;
  weightKg: number;
  /** True for fixtures whose photometrics vary with colour mixing. */
  colourMixing?: boolean;
  /** Pan/tilt travel for moving heads, degrees. Absent for static fixtures. */
  panRange?: number;
  tiltRange?: number;
  notes?: string;
}

export interface FixtureOptic {
  id: string;
  /** "26°", "Zoom 15°", "Flood" — whatever is written on the fixture. */
  label: string;
  photometrics: FixturePhotometrics;
  /**
   * For a zoom fixture, the continuous range this optic covers. The stored
   * photometry is at `zoomMin`; `scaleZoom` derives intermediate angles.
   */
  zoomMin?: number;
  zoomMax?: number;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

export type StructureKind = 'truss' | 'scaff' | 'stand' | 'bar' | 'floor';

/**
 * Something you hang fixtures on. A `truss`, `scaff` or `bar` is a straight run
 * between two points and fixtures sit at a distance along it; a `stand` is a
 * single point; `floor` is a virtual structure for fixtures standing on the deck.
 */
export interface Structure {
  id: string;
  name: string;
  kind: StructureKind;
  /** Start of the run, world metres. For a stand, the base position. */
  from: Vec3;
  /** End of the run. For a stand, equals `from` with `z` at working height. */
  to: Vec3;
  /** Cross-section for the wireframe and for the loading check, metres. */
  sizeM?: number;
  /** Safe working load, kg. Absent means unknown, and the UI says so. */
  swlKg?: number;
  /** Stands only: manufacturer's maximum working height, metres. */
  maxHeightM?: number;
  colour?: string;
}

export type FocusMode = 'aim' | 'angles';

/** One fixture, hung, focused, and at a level. */
export interface RigFixture {
  id: string;
  /** Channel / unit number as it appears on the plot. */
  channel: string;
  modelId: string;
  opticId: string;
  structureId: string;
  /**
   * Distance along the structure from `from` to `to`, metres. Ignored for
   * stands and floor fixtures, which use `position` directly.
   */
  along: number;
  /** Resolved world position. Derived from the structure, cached here. */
  position: Vec3;

  focusMode: FocusMode;
  /** `focusMode: 'aim'` — the point on the stage the fixture is pointed at. */
  aim: Vec3;
  /**
   * `focusMode: 'angles'` — pan and tilt in degrees. Pan 0 is straight upstage
   * (+y), positive toward +x. Tilt 0 is horizontal, -90 is straight down.
   */
  pan: number;
  tilt: number;
  /** Rotation of the distribution about the beam axis, degrees. */
  roll: number;

  /** Zoom setting in degrees field angle, for zoomable fixtures. */
  zoom?: number;
  /** Intensity 0..1. */
  level: number;
  /** Gel / colour transmission 0..1, multiplied straight into the intensity. */
  transmission: number;
  gelName?: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Stage and measurement
// ---------------------------------------------------------------------------

export interface Stage {
  widthM: number;
  depthM: number;
  /** Deck height above the origin plane, metres. Usually 0 or a riser height. */
  heightM: number;
}

export type PlaneOrientation = 'horizontal' | 'vertical';

/**
 * The surface the levels are calculated on.
 *
 * `horizontal` is the classic wash calculation: a plane parallel to the deck at
 * `heightM`. Set it to 0 for a floor wash, or 1.5 for illuminance at head
 * height.
 *
 * `vertical` is the one that actually matters for faces and for camera: a plane
 * standing at head height whose normal points **downstage at the audience**, so
 * a fixture directly overhead contributes almost nothing to it. A rig that looks
 * even on the horizontal plane and dark on the vertical one is a rig with no
 * front light, which is the single most common thing this tool should catch.
 */
export interface MeasurementPlane {
  orientation: PlaneOrientation;
  /** Height of the plane above the deck, metres. */
  heightM: number;
  /** Grid spacing, metres. */
  resolutionM: number;
}

export interface Targets {
  /** Design illuminance, lux. Coverage is measured against this. */
  targetLux: number;
  /** Below this fraction of target, a cell is a dark spot. */
  darkFraction: number;
  /** Above this multiple of target, a cell is a hot spot. */
  hotMultiple: number;
  /** Minimum acceptable min:avg uniformity. */
  minUniformity: number;
}

export interface Project {
  version: 1;
  name: string;
  stage: Stage;
  plane: MeasurementPlane;
  targets: Targets;
  structures: Structure[];
  fixtures: RigFixture[];
  /** Custom fixture models created or imported in this project. */
  customModels: FixtureModel[];
}

// ---------------------------------------------------------------------------
// Solver output
// ---------------------------------------------------------------------------

export interface Grid {
  /** Number of samples across x and along y (or z, for a vertical plane). */
  cols: number;
  rows: number;
  /** World position of the first sample. */
  originX: number;
  originY: number;
  spacing: number;
  /** Illuminance in lux, row-major, `rows * cols` long. */
  lux: Float32Array;
}

export interface Metrics {
  min: number;
  max: number;
  avg: number;
  median: number;
  /** min:avg — the uniformity figure a designer quotes. */
  uniformityMinAvg: number;
  /** min:max — the harsher one. */
  uniformityMinMax: number;
  /** Fraction of the stage at or above the target. */
  coverage: number;
  /** Fraction below `targetLux * darkFraction`. */
  darkFraction: number;
  /** Fraction above `targetLux * hotMultiple`. */
  hotFraction: number;
}

/** A contiguous run of cells that are too dark or too bright. */
export interface Blob {
  kind: 'hot' | 'dark';
  cellCount: number;
  /** Area in square metres. */
  areaM2: number;
  /** Centroid, world metres. */
  cx: number;
  cy: number;
  /** Extreme value found inside the blob, lux. */
  peakLux: number;
}

export interface SolveResult {
  grid: Grid;
  metrics: Metrics;
  blobs: Blob[];
  /** Per-fixture contribution to the average, lux. Ordered as `fixtures`. */
  perFixtureAvg: number[];
  /** Milliseconds the solve took. */
  elapsedMs: number;
}
