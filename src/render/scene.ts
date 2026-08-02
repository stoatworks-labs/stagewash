/**
 * The wireframe 3D plot.
 *
 * Deliberately **not** a render of what the stage will look like. It is a
 * diagram: hairline geometry, flat colour, no lighting, no shadows, no
 * materials. The photorealistic version of this would be slower, harder to
 * read, and would imply a precision the underlying model does not have. The
 * reference is ArrayCalc's plot window — an engineering view you can rotate.
 *
 * The only lit-looking thing is the heatmap, and that is data, not a render.
 *
 * ## Coordinates
 *
 * The domain is z-up (see `types.ts`); three.js defaults to y-up. Rather than
 * rotating every piece of geometry, the whole scene is built z-up and the
 * camera's `up` is set to +z. Everything in this file is therefore in domain
 * coordinates, with no conversion anywhere — which is the point, because a
 * half-applied coordinate conversion is invisible until something is mirrored.
 */

import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  type Camera,
  Color,
  ConeGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';

import { beamFootprint, fixtureFrame, DEG } from '../domain/geometry';
import { fieldAngleOf } from '../domain/photometry/distribution';
import type { PreparedFixture } from '../domain/rig';
import type { Grid, Project, Structure, Vec3 } from '../domain/types';
import { buildHeatmapTexture, chooseScale, type Ramp } from './heatmap';

const COLOURS = {
  stage: 0x4a5a6a,
  stageFill: 0x0e1620,
  grid: 0x243240,
  structure: 0x7fa8ce,
  structureSelected: 0xffd479,
  fixture: 0xb9cbdb,
  fixtureSelected: 0xffd479,
  fixtureDisabled: 0x44505c,
  beam: 0xffe9b0,
  beamSelected: 0xffd479,
  footprint: 0xffcf6b,
  axis: 0x35485c,
} as const;

export interface SceneHandle {
  render: () => void;
  resize: (width: number, height: number) => void;
  setProject: (
    project: Project,
    fixtures: PreparedFixture[],
    selection: Set<string>,
    selectedStructureId: string | null,
  ) => void;
  setHeatmap: (grid: Grid | null, scaleMax: number | null, ramp: Ramp) => void;
  setOptions: (options: SceneOptions) => void;
  frameAll: () => void;
  /**
   * Point the camera. With `fit`, the whole rig is framed at the current
   * aspect — which is what an exported plot needs and what an interactively
   * orbited viewport must not do behind the user's back. A fitted `plan` or
   * `section` also switches to a parallel projection; see `fitOrthographic`.
   */
  setView: (view: ViewName, fit?: boolean) => void;
  /** The camera the viewport orbits and picks with. Always perspective. */
  camera: PerspectiveCamera;
  /**
   * The camera the last `render` actually used — which is not `camera` after a
   * fitted plan. Anything projecting world points into the frame has to ask for
   * this one, or it will place them under a different projection to the picture.
   */
  renderCamera: () => Camera;
  /**
   * Free three's GPU resources.
   *
   * `releaseContext` additionally hands the WebGL context back, which a browser
   * needs because it only allows a handful at once and the report opens a new
   * one every time it runs. Pass it **only** when the canvas is being thrown
   * away with the scene: a canvas whose context has been force-lost can never
   * be given another one, so doing this to a canvas that will be mounted again
   * — a React remount, a StrictMode double-invoke — leaves a dead viewport.
   */
  dispose: (releaseContext?: boolean) => void;
  /** Pick a fixture id at normalised device coordinates, or null. */
  pick: (ndcX: number, ndcY: number) => string | null;
}

export interface SceneOptions {
  showHeatmap: boolean;
  showBeams: boolean;
  showFootprints: boolean;
  showGrid: boolean;
  beamOpacity: number;
  isolateSelection: boolean;
}

export type ViewName = 'plan' | 'section' | 'iso';

/**
 * Camera directions, as a unit vector from the subject towards the camera.
 *
 * `plan` carries a whisker of -y so that it is not exactly parallel to the
 * camera's up vector (+z): the cross product that builds the view basis
 * collapses when they are, and the frame ends up rolled to an arbitrary angle.
 * That whisker also settles which way round the plan reads — upstage at the
 * top, downstage at the bottom, as on a lighting plot.
 */
const VIEW_DIRECTIONS: Record<ViewName, Vector3> = {
  plan: new Vector3(0, -0.0001, 1).normalize(),
  section: new Vector3(0, -1, 0.15).normalize(),
  iso: new Vector3(0.9, -1.1, 0.8).normalize(),
};

/**
 * Everything a plot has to contain: the deck, both ends of every structure —
 * including a stand's base, which is on the floor rather than at `from.z` — and
 * every hang point. The heatmap covers exactly the deck, so it needs no
 * separate term.
 *
 * Exported because the report sizes its pictures from this. A rig is often
 * deeper than it is wide once a FOH position is included, and a plan of it
 * drawn in a landscape frame is mostly empty.
 */
export function contentBounds(project: Project): Box3 {
  const { widthM, depthM, heightM } = project.stage;
  const box = new Box3();
  box.expandByPoint(new Vector3(-widthM / 2, 0, Math.min(0, heightM)));
  box.expandByPoint(new Vector3(widthM / 2, depthM, heightM));

  for (const structure of project.structures) {
    box.expandByPoint(new Vector3(structure.from.x, structure.from.y, structure.from.z));
    box.expandByPoint(new Vector3(structure.to.x, structure.to.y, structure.to.z));
    if (structure.kind === 'stand') {
      box.expandByPoint(new Vector3(structure.from.x, structure.from.y, 0));
    }
  }
  for (const f of project.fixtures) {
    box.expandByPoint(new Vector3(f.position.x, f.position.y, f.position.z));
  }
  return box;
}

export interface SceneSetup {
  /**
   * Keep the drawing buffer after the frame is composited, so `toDataURL` on
   * the canvas returns the picture rather than an empty rectangle. Off for the
   * live viewport, which never reads itself back and pays for the copy.
   */
  preserveDrawingBuffer?: boolean;
  /**
   * Pin the device pixel ratio. The report renderer sets this so an exported
   * plot is the same resolution on a laptop as on a 5K display.
   */
  pixelRatio?: number;
}

export function createScene(canvas: HTMLCanvasElement, setup: SceneSetup = {}): SceneHandle {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: setup.preserveDrawingBuffer ?? false,
  });
  renderer.setPixelRatio(setup.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(new Color(0x080d13), 1);

  const scene = new Scene();

  const camera = new PerspectiveCamera(45, 1, 0.1, 500);
  // z-up, so the plot reads like a plan and a section rather than needing the
  // whole model rotated into three's y-up convention.
  camera.up.set(0, 0, 1);
  camera.position.set(0, -18, 12);

  /**
   * The parallel-projection camera, used only for a fitted plan or section.
   *
   * A perspective "plan" is not a plan. The rig hangs six metres above the deck
   * the heatmap is painted on, so perspective throws every fixture outwards
   * from its true position — by a factor of four once the camera is close
   * enough for the stage to fill the frame. Anyone reading a position off it
   * would be wrong, and the wireframe would no longer sit over the heatmap it
   * is meant to be a key to. Orthographic puts every fixture exactly on its own
   * x, y, which is the entire point of drawing a plan.
   */
  const orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  orthographic.up.set(0, 0, 1);

  let active: Camera = camera;
  let aspect = 1;

  const stageGroup = new Group();
  const structureGroup = new Group();
  const fixtureGroup = new Group();
  const beamGroup = new Group();
  const footprintGroup = new Group();
  const heatmapGroup = new Group();
  scene.add(stageGroup, heatmapGroup, structureGroup, fixtureGroup, beamGroup, footprintGroup);

  let options: SceneOptions = {
    showHeatmap: true,
    showBeams: true,
    showFootprints: true,
    showGrid: true,
    beamOpacity: 0.1,
    isolateSelection: false,
  };

  let currentProject: Project | null = null;
  let currentFixtures: PreparedFixture[] = [];
  let currentSelection = new Set<string>();
  /** Bounding spheres for picking, in the order of `currentFixtures`. */
  let pickTargets: Array<{ id: string; sphere: Sphere }> = [];

  // -------------------------------------------------------------------------
  // Disposal helpers. three does not free GPU memory when you drop a reference,
  // and this scene is rebuilt on every edit, so leaking here is a hard crash
  // after a few minutes of dragging rather than a slow degradation.
  // -------------------------------------------------------------------------
  function clear(group: Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      disposeObject(child);
    }
  }

  function disposeObject(object: unknown): void {
    const node = object as {
      geometry?: { dispose: () => void };
      material?: { dispose: () => void; map?: { dispose: () => void } };
      children?: unknown[];
    };
    node.geometry?.dispose();
    if (node.material) {
      node.material.map?.dispose();
      node.material.dispose();
    }
    for (const child of node.children ?? []) disposeObject(child);
  }

  const v = (p: Vec3): Vector3 => new Vector3(p.x, p.y, p.z);

  function lineSegments(points: number[], colour: number, opacity = 1): LineSegments {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    return new LineSegments(
      geometry,
      new LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity }),
    );
  }

  // -------------------------------------------------------------------------
  // Stage
  // -------------------------------------------------------------------------
  function buildStage(project: Project): void {
    clear(stageGroup);
    const { widthM, depthM, heightM } = project.stage;
    const hw = widthM / 2;

    // Deck outline plus a faint fill, so the stage reads as a surface in an
    // isometric view without pretending to be a material.
    const fill = new Mesh(
      new PlaneGeometry(widthM, depthM),
      new MeshBasicMaterial({
        color: COLOURS.stageFill,
        transparent: true,
        opacity: 0.85,
        side: DoubleSide,
      }),
    );
    fill.position.set(0, depthM / 2, heightM - 0.002);
    stageGroup.add(fill);

    const outline: number[] = [];
    const corners: Array<[number, number]> = [
      [-hw, 0],
      [hw, 0],
      [hw, depthM],
      [-hw, depthM],
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i] as [number, number];
      const b = corners[(i + 1) % 4] as [number, number];
      outline.push(a[0], a[1], heightM, b[0], b[1], heightM);
    }
    stageGroup.add(lineSegments(outline, COLOURS.stage));

    if (options.showGrid) {
      const grid: number[] = [];
      for (let x = Math.ceil(-hw); x <= hw; x++) {
        grid.push(x, 0, heightM, x, depthM, heightM);
      }
      for (let y = 1; y < depthM; y++) {
        grid.push(-hw, y, heightM, hw, y, heightM);
      }
      stageGroup.add(lineSegments(grid, COLOURS.grid, 0.55));
    }

    // Centre line and the downstage edge marker: the two references anyone
    // reading a lighting plot looks for first.
    stageGroup.add(
      lineSegments([0, 0, heightM + 0.003, 0, depthM, heightM + 0.003], COLOURS.axis, 0.9),
    );
  }

  // -------------------------------------------------------------------------
  // Structures
  // -------------------------------------------------------------------------
  function buildStructures(project: Project, selectedStructure: string | null): void {
    clear(structureGroup);

    for (const structure of project.structures) {
      const selected = structure.id === selectedStructure;
      const colour = selected ? COLOURS.structureSelected : COLOURS.structure;
      structureGroup.add(structureGeometry(structure, colour));
    }
  }

  function structureGeometry(structure: Structure, colour: number): LineSegments {
    const from = v(structure.from);
    const to = v(structure.to);
    const size = structure.sizeM ?? 0.29;

    if (structure.kind === 'stand') {
      // A stand is drawn as a mast with a tripod base, because its footprint on
      // the deck is a real planning constraint — you have to be able to see
      // whether it lands in a walkway.
      const points: number[] = [from.x, from.y, 0, to.x, to.y, to.z];
      const legs = 3;
      const spread = 0.55;
      for (let i = 0; i < legs; i++) {
        const a = (i / legs) * Math.PI * 2;
        points.push(
          from.x,
          from.y,
          Math.min(to.z, from.z) * 0.35,
          from.x + Math.cos(a) * spread,
          from.y + Math.sin(a) * spread,
          0,
        );
      }
      // Cross-bar at the top if the run has length.
      if (from.distanceTo(to) > 0.05) points.push(from.x, from.y, to.z, to.x, to.y, to.z);
      return lineSegments(points, colour);
    }

    if (structure.kind === 'truss') {
      // A box truss drawn as four chords and a few diagonals. Enough to read as
      // truss rather than as a pipe; not a structural model.
      const axis = new Vector3().subVectors(to, from);
      const len = axis.length();
      if (len < 1e-6) return lineSegments([], colour);
      axis.normalize();

      const reference = Math.abs(axis.z) > 0.99 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
      const right = new Vector3().crossVectors(axis, reference).normalize().multiplyScalar(size / 2);
      const up = new Vector3().crossVectors(right, axis).normalize().multiplyScalar(size / 2);

      const corner = (end: Vector3, sx: number, sy: number): Vector3 =>
        new Vector3()
          .copy(end)
          .addScaledVector(right, sx)
          .addScaledVector(up, sy);

      const signs: Array<[number, number]> = [
        [1, 1],
        [1, -1],
        [-1, -1],
        [-1, 1],
      ];
      const points: number[] = [];
      for (const [sx, sy] of signs) {
        const a = corner(from, sx, sy);
        const b = corner(to, sx, sy);
        points.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      // Bracing on one face only, at roughly 1 m panels.
      //
      // Drawing both faces at 0.5 m — which is nearer the truth for a real
      // truss — produced a dense zigzag that reads as visual noise at the zoom
      // levels this plot is actually used at, and competes with the beams for
      // attention. This is a diagram of where the bar is, not a structural
      // drawing, so one face at a coarser pitch says "truss" and then gets out
      // of the way.
      const panels = Math.max(1, Math.round(len));
      for (let i = 0; i < panels; i++) {
        const e0 = new Vector3().lerpVectors(from, to, i / panels);
        const e1 = new Vector3().lerpVectors(from, to, (i + 1) / panels);
        const flip = i % 2 === 0;
        const a = corner(e0, flip ? 1 : -1, 1);
        const b = corner(e1, flip ? -1 : 1, 1);
        points.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      return lineSegments(points, colour);
    }

    // Scaff, bar and floor: a single line with end caps.
    const points = [from.x, from.y, from.z, to.x, to.y, to.z];
    return lineSegments(points, colour);
  }

  // -------------------------------------------------------------------------
  // Fixtures, beams, footprints
  // -------------------------------------------------------------------------
  function buildFixtures(project: Project, prepared: PreparedFixture[], selection: Set<string>): void {
    clear(fixtureGroup);
    clear(beamGroup);
    clear(footprintGroup);
    pickTargets = [];

    const preparedById = new Map(prepared.map((f) => [f.id, f]));

    for (const rigFixture of project.fixtures) {
      const selected = selection.has(rigFixture.id);
      const prep = preparedById.get(rigFixture.id);
      const position = v(rigFixture.position);

      const colour = !rigFixture.enabled
        ? COLOURS.fixtureDisabled
        : selected
          ? COLOURS.fixtureSelected
          : COLOURS.fixture;

      // Direction: use the prepared frame when the fixture is live, otherwise
      // derive it so a fixture at zero level still draws pointing the right way.
      const forward = prep
        ? new Vector3(prep.frame.forward.x, prep.frame.forward.y, prep.frame.forward.z)
        : new Vector3().subVectors(v(rigFixture.aim), position).normalize();

      fixtureGroup.add(fixtureBody(position, forward, colour));
      pickTargets.push({ id: rigFixture.id, sphere: new Sphere(position.clone(), 0.4) });

      const isolated = options.isolateSelection && selection.size > 0 && !selected;
      if (!rigFixture.enabled || isolated) continue;

      const fieldAngle = prep
        ? prep.photometry.kind === 'analytic'
          ? fieldAngleOf(prep.photometry)
          : (prep.maxGamma * 2) / 3
        : 30;

      if (options.showBeams) {
        beamGroup.add(
          beamCone(position, forward, fieldAngle, selected, project.stage.heightM),
        );
      }

      if (options.showFootprints) {
        const ring = beamFootprint(
          rigFixture.position,
          { x: forward.x, y: forward.y, z: forward.z },
          fieldAngle / 2,
          project.stage.heightM + 0.004,
        );
        if (ring.length > 0) footprintGroup.add(footprintRing(ring, selected));
      }
    }
  }

  /** A small open cone: reads as "fixture pointing that way" at any zoom. */
  function fixtureBody(position: Vector3, forward: Vector3, colour: number): LineSegments {
    const bodyLength = 0.38;
    const geometry = new ConeGeometry(0.13, bodyLength, 6, 1, true);
    const edges = new EdgesGeometry(geometry);
    geometry.dispose();

    const mesh = new LineSegments(edges, new LineBasicMaterial({ color: colour }));
    // ConeGeometry points along +y with its tip at +length/2. Aim the tip along
    // the beam and pull the body back so the lens sits at the hang point.
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), forward.clone().normalize());
    mesh.position.copy(position).addScaledVector(forward, -bodyLength / 2);
    return mesh;
  }

  /**
   * The beam, drawn to where it lands rather than to a fixed length.
   *
   * Additive blending so overlapping beams get brighter where they overlap,
   * which is the one place a rendering trick tells the truth: that *is* what
   * happens to the light.
   */
  function beamCone(
    position: Vector3,
    forward: Vector3,
    fieldAngle: number,
    selected: boolean,
    deckZ: number,
  ): Mesh {
    // Stop the cone at the deck when it points down, and give it a fixed length
    // when it does not, so a fixture aimed at the horizon does not draw a cone
    // to the edge of the world.
    // Stop a whisker short of the deck. Running the cone exactly to z = deckZ
    // puts its base in the same plane as the heatmap, and the two z-fight.
    const drop = position.z - deckZ;
    const throwLength =
      forward.z < -0.05 && drop > 0 ? Math.min(drop / -forward.z, 60) * 0.985 : 12;

    const radius = Math.tan((fieldAngle / 2) * DEG) * throwLength;
    const geometry = new ConeGeometry(radius, throwLength, 24, 1, true);

    const mesh = new Mesh(
      geometry,
      new MeshBasicMaterial({
        color: selected ? COLOURS.beamSelected : COLOURS.beam,
        transparent: true,
        opacity: options.beamOpacity * (selected ? 2.2 : 1),
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    // Cone apex at +y/2 in local space; put the apex at the lens.
    mesh.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), forward.clone().normalize());
    mesh.position.copy(position).addScaledVector(forward, throwLength / 2);
    return mesh;
  }

  function footprintRing(ring: Vec3[], selected: boolean): LineSegments {
    const points: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Vec3;
      const b = ring[(i + 1) % ring.length] as Vec3;
      points.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    return lineSegments(points, selected ? COLOURS.fixtureSelected : COLOURS.footprint, selected ? 0.95 : 0.5);
  }

  // -------------------------------------------------------------------------
  // Heatmap
  // -------------------------------------------------------------------------
  function buildHeatmap(grid: Grid | null, scaleMax: number | null, ramp: Ramp): void {
    clear(heatmapGroup);
    if (!grid || !options.showHeatmap || !currentProject) return;

    const scale = chooseScale(grid, scaleMax);
    const texture = buildHeatmapTexture(grid, scale, ramp);

    const width = (grid.cols - 1) * grid.spacing;
    const height = (grid.rows - 1) * grid.spacing;

    const plane = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.9, side: DoubleSide }),
    );

    const { plane: measurement, stage } = currentProject;
    // The vertical plane is a *measurement* surface, not a physical one: it is
    // drawn lying on the deck like the horizontal map, because what the user
    // wants to see is "where on the stage is a face lit", which is a position
    // on the floor plan, not a wall floating in the air.
    plane.position.set(
      grid.originX + width / 2,
      grid.originY + height / 2,
      stage.heightM + (measurement.orientation === 'horizontal' ? 0.001 : 0.001),
    );
    heatmapGroup.add(plane);
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------
  function frameAll(): void {
    if (!currentProject) return;
    const { widthM, depthM } = currentProject.stage;
    const radius = Math.max(widthM, depthM) * 0.75 + 4;
    const centre = new Vector3(0, depthM / 2, 1);

    const direction = new Vector3().subVectors(camera.position, centre).normalize();
    if (direction.lengthSq() < 1e-6) direction.set(0, -1, 0.6).normalize();
    camera.position.copy(centre).addScaledVector(direction, radius * 1.6);
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
  }

  /**
   * The content's extent in a camera's own basis: how far it reaches sideways,
   * how far up and down the frame, and how deep it runs along the view axis.
   */
  function extentsAlong(
    box: Box3,
    centre: Vector3,
    xAxis: Vector3,
    yAxis: Vector3,
    zAxis: Vector3,
  ): { x: number; y: number; depth: number } {
    const corner = new Vector3();
    let x = 0;
    let y = 0;
    let depth = 0;

    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        .sub(centre);
      x = Math.max(x, Math.abs(corner.dot(xAxis)));
      y = Math.max(y, Math.abs(corner.dot(yAxis)));
      depth = Math.max(depth, Math.abs(corner.dot(zAxis)));
    }

    return { x, y, depth };
  }

  function viewBasis(direction: Vector3, up: Vector3) {
    const zAxis = direction.clone().normalize();
    const xAxis = new Vector3().crossVectors(up, zAxis).normalize();
    const yAxis = new Vector3().crossVectors(zAxis, xAxis).normalize();
    return { xAxis, yAxis, zAxis };
  }

  /**
   * Frame the content in parallel projection: no distance to solve, just a
   * frustum wide enough for the extents, and the camera far enough back that
   * nothing lands behind the near plane.
   */
  function fitOrthographic(direction: Vector3, margin: number): void {
    if (!currentProject) return;
    const box = contentBounds(currentProject);
    const centre = box.getCenter(new Vector3());
    const { xAxis, yAxis, zAxis } = viewBasis(direction, orthographic.up);
    const extent = extentsAlong(box, centre, xAxis, yAxis, zAxis);

    const halfHeight = Math.max(extent.y, extent.x / aspect, 0.5) * margin;
    const halfWidth = halfHeight * aspect;

    orthographic.left = -halfWidth;
    orthographic.right = halfWidth;
    orthographic.top = halfHeight;
    orthographic.bottom = -halfHeight;
    orthographic.near = 0.1;
    orthographic.far = extent.depth * 4 + 100;
    orthographic.position.copy(centre).addScaledVector(zAxis, extent.depth * 2 + 20);
    orthographic.lookAt(centre);
    orthographic.updateProjectionMatrix();
    active = orthographic;
  }

  /**
   * Solve the camera distance that just contains the content.
   *
   * Fitting the bounding *sphere* is the one-liner and it wastes a third of the
   * frame on a stage, which is a wide flat box. So each of the eight corners is
   * asked how far back the camera would have to be for it to sit on the edge of
   * the frustum — accounting for the corner's own depth, which is what the
   * sphere version throws away — and the furthest answer wins.
   */
  function fitPerspective(direction: Vector3, margin: number): void {
    if (!currentProject) return;
    const box = contentBounds(currentProject);
    const centre = box.getCenter(new Vector3());
    const { xAxis, yAxis, zAxis } = viewBasis(direction, camera.up);

    const tanV = Math.tan((camera.fov / 2) * DEG) / margin;
    const tanH = tanV * camera.aspect;

    let distance = 0;
    const corner = new Vector3();
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        .sub(centre);
      const depth = corner.dot(zAxis);
      distance = Math.max(
        distance,
        Math.abs(corner.dot(xAxis)) / tanH + depth,
        Math.abs(corner.dot(yAxis)) / tanV + depth,
      );
    }

    camera.position.copy(centre).addScaledVector(zAxis, Math.max(distance, 1));
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
    active = camera;
  }

  function setView(view: ViewName, fit = false): void {
    if (!currentProject) return;
    if (fit) {
      // `iso` stays perspective: it is a pictorial view of the rig, and it is
      // what the app's own Iso button shows. Plan and section are drawing
      // conventions, and both of those mean parallel projection.
      if (view === 'iso') fitPerspective(VIEW_DIRECTIONS[view], 1.06);
      else fitOrthographic(VIEW_DIRECTIONS[view], 1.06);
      return;
    }

    active = camera;

    const { widthM, depthM } = currentProject.stage;
    const centre = new Vector3(0, depthM / 2, 0);
    const radius = Math.max(widthM, depthM);

    if (view === 'plan') {
      camera.position.set(0, depthM / 2 - 0.001, radius * 1.5);
    } else if (view === 'section') {
      camera.position.set(0, -radius * 1.6, 3);
    } else {
      camera.position.set(radius * 0.9, -radius * 1.1, radius * 0.8);
    }
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------
  function pick(ndcX: number, ndcY: number): string | null {
    // Ray/sphere rather than mesh raycasting: the fixture bodies are
    // LineSegments, which raycast against individual lines and are practically
    // impossible to hit with a mouse. A 0.4 m sphere at the hang point is what
    // the user is actually aiming at.
    const origin = camera.position.clone();
    const target = new Vector3(ndcX, ndcY, 0.5).unproject(camera);
    const direction = target.sub(origin).normalize();

    let best: { id: string; distance: number } | null = null;
    for (const { id, sphere } of pickTargets) {
      const toCentre = new Vector3().subVectors(sphere.center, origin);
      const along = toCentre.dot(direction);
      if (along < 0) continue;
      const perpendicular = toCentre.lengthSq() - along * along;
      if (perpendicular > sphere.radius * sphere.radius) continue;
      if (!best || along < best.distance) best = { id, distance: along };
    }
    return best?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------
  let lastGrid: Grid | null = null;
  let lastScaleMax: number | null = null;
  let lastRamp: Ramp = 'viridis';
  let selectedStructureId: string | null = null;

  return {
    camera,

    renderCamera: () => active,

    render: () => renderer.render(scene, active),

    resize: (width, height) => {
      renderer.setSize(width, height, false);
      aspect = height > 0 ? width / height : 1;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    setProject: (project, fixtures, selection, structureId) => {
      currentProject = project;
      currentFixtures = fixtures;
      currentSelection = selection;
      selectedStructureId = structureId;
      buildStage(project);
      buildStructures(project, selectedStructureId);
      buildFixtures(project, fixtures, selection);
      buildHeatmap(lastGrid, lastScaleMax, lastRamp);
    },

    setHeatmap: (grid, scaleMax, ramp) => {
      lastGrid = grid;
      lastScaleMax = scaleMax;
      lastRamp = ramp;
      buildHeatmap(grid, scaleMax, ramp);
    },

    setOptions: (next) => {
      options = next;
      if (currentProject) {
        buildStage(currentProject);
        buildStructures(currentProject, selectedStructureId);
        buildFixtures(currentProject, currentFixtures, currentSelection);
        buildHeatmap(lastGrid, lastScaleMax, lastRamp);
      }
    },

    frameAll,
    setView,
    pick,

    dispose: (releaseContext = false) => {
      clear(stageGroup);
      clear(structureGroup);
      clear(fixtureGroup);
      clear(beamGroup);
      clear(footprintGroup);
      clear(heatmapGroup);
      renderer.dispose();
      if (releaseContext) renderer.forceContextLoss();
    },
  };
}

/** Exported for the inspector's "what is this fixture pointing at" readout. */
export function aimDirection(position: Vec3, aim: Vec3, roll: number) {
  return fixtureFrame(
    { x: aim.x - position.x, y: aim.y - position.y, z: aim.z - position.z },
    roll,
  );
}
