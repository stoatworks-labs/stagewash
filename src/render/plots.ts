/**
 * The plots that go in the PDF report.
 *
 * ## Why this reuses the viewport's scene
 *
 * The obvious implementation is a second, simpler drawing routine — a 2D canvas
 * with the grid painted into it. That would be less code and it would be wrong:
 * the report and the screen would then be two drawings of the same rig that
 * drift apart the first time either is changed, and a report that disagrees
 * with the app is worse than a report with no pictures in it. So this builds
 * the *same* `createScene` against an offscreen canvas, points its camera three
 * times, and reads the frames back.
 *
 * ## Why the options are hard-coded
 *
 * The view toggles in the UI are for looking at the rig, not for authoring a
 * document. If the report inherited them, two exports of the same project could
 * come out looking completely different — one with beams and one without —
 * because of a switch someone flicked ten minutes earlier. The report always
 * shows the same three plots.
 *
 * The one thing it does inherit is the colour scale's top end, because that is
 * a statement about the *data*: if the user has pinned the scale to compare two
 * rigs, a report that silently re-autoscaled would be a lie.
 */

import { Vector3, type Camera } from 'three';

import { FIXTURE_LIBRARY } from '../data/fixtures';
import { modelIndex, prepareRig } from '../domain/rig';
import type { Grid, Project } from '../domain/types';
import { contentBounds, createScene, type SceneOptions, type ViewName } from './scene';

/** Where a fixture landed in the frame, as a fraction of width and height. */
export interface PlotLabel {
  text: string;
  u: number;
  v: number;
}

export interface ReportPlot {
  key: 'plan' | 'iso' | 'layout';
  /** PNG data URL. */
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  /** Channel numbers, positioned in frame. Empty unless the plot asked for them. */
  labels: PlotLabel[];
}

/**
 * Pixels per CSS pixel for the offscreen renders. At the sizes below this puts
 * the plan plot at 250 dpi or better across an A4 text block — enough that the
 * hairlines survive printing, without a megabyte of PNG per plot.
 */
const PIXEL_RATIO = 2;

const BASE_OPTIONS: SceneOptions = {
  showHeatmap: true,
  showBeams: false,
  showFootprints: false,
  showGrid: true,
  // Just above the app's 0.045, because these are read at a third of the size
  // and on paper. Not much above it: beam cones are additively blended, so
  // winding this up bleaches the heatmap underneath — which is the thing the
  // report is about.
  beamOpacity: 0.06,
  isolateSelection: false,
};

interface PlotSpec {
  key: ReportPlot['key'];
  view: ViewName;
  /** The frame's long edge in CSS pixels; the short edge follows the aspect. */
  longEdgePx: number;
  aspect: number;
  options: SceneOptions;
  label: boolean;
}

/** The isometric is pictorial, so it gets a conventional landscape frame. */
const ISO_ASPECT = 1.5;

/**
 * How far a plan is allowed to depart from a landscape picture. A rig with a
 * FOH position 7 m out from a 6 m stage is *taller* than it is wide seen from
 * above, and forcing that into a 3:2 frame spends a third of the picture on
 * black. The clamp stops a pathological rig — one fixture parked 100 m away —
 * from producing a letterbox nothing can be read off.
 */
const PLAN_ASPECT_RANGE = [0.8, 2.5] as const;

/**
 * Plan and layout are rendered at the same aspect, so that fitting the camera
 * to the rig gives them the same frame. That is what makes the wireframe a key
 * to the heatmap — a pool on one sits over the fixture that made it on the
 * other — and it only holds because both are drawn in parallel projection.
 */
function specs(planAspect: number): PlotSpec[] {
  return [
    {
      key: 'plan',
      view: 'plan',
      longEdgePx: 900,
      aspect: planAspect,
      options: BASE_OPTIONS,
      label: false,
    },
    {
      key: 'iso',
      view: 'iso',
      longEdgePx: 456,
      aspect: ISO_ASPECT,
      options: { ...BASE_OPTIONS, showBeams: true, showFootprints: true },
      label: false,
    },
    {
      key: 'layout',
      view: 'plan',
      longEdgePx: 456,
      aspect: planAspect,
      options: { ...BASE_OPTIONS, showHeatmap: false, showFootprints: true },
      label: true,
    },
  ];
}

/** The rig's footprint seen from above, width ÷ depth, clamped to something drawable. */
function planAspectFor(project: Project): number {
  const size = contentBounds(project).getSize(new Vector3());
  const raw = size.x / Math.max(size.y, 0.5);
  const [low, high] = PLAN_ASPECT_RANGE;
  return Math.min(Math.max(raw, low), high);
}

function frameSize(spec: PlotSpec): { width: number; height: number } {
  return spec.aspect >= 1
    ? { width: spec.longEdgePx, height: Math.round(spec.longEdgePx / spec.aspect) }
    : { width: Math.round(spec.longEdgePx * spec.aspect), height: spec.longEdgePx };
}

const NO_SELECTION: ReadonlySet<string> = new Set();

/**
 * Render the report's plots. Returns an empty array if anything about the
 * render fails — most likely a browser that will not give us a WebGL context.
 * A report without pictures is still a report; a failed export is not, and the
 * numbers are the part that matters. The PDF drops the page if it does not get
 * all three.
 */
export function renderReportPlots(
  project: Project,
  grid: Grid,
  scaleMaxLux: number | null,
): ReportPlot[] {
  const canvas = document.createElement('canvas');

  let scene;
  try {
    scene = createScene(canvas, { preserveDrawingBuffer: true, pixelRatio: PIXEL_RATIO });
  } catch {
    return [];
  }

  try {
    const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
    const prepared = prepareRig(project, models);
    const plots: ReportPlot[] = [];

    for (const spec of specs(planAspectFor(project))) {
      const { width, height } = frameSize(spec);
      scene.resize(width, height);
      scene.setOptions(spec.options);
      scene.setProject(project, prepared, new Set(NO_SELECTION), null);
      scene.setHeatmap(spec.options.showHeatmap ? grid : null, scaleMaxLux, 'viridis');
      // After `resize`, so the fit sees the aspect it is fitting to.
      scene.setView(spec.view, true);
      scene.render();

      plots.push({
        key: spec.key,
        dataUrl: canvas.toDataURL('image/png'),
        widthPx: width * PIXEL_RATIO,
        heightPx: height * PIXEL_RATIO,
        // Projected after the render, because that is what brings the camera's
        // inverse world matrix up to date, and through `renderCamera` because a
        // fitted plan is drawn with the orthographic one.
        labels: spec.label ? projectLabels(project, scene.renderCamera()) : [],
      });
    }

    return plots;
  } catch {
    return [];
  } finally {
    // The canvas dies with this call and is dropped on the next line anyway.
    scene.dispose(true);
  }
}

/**
 * Channel numbers, in frame coordinates.
 *
 * The scene draws no text — adding a sprite per fixture would put a font, and
 * its scaling behaviour, into an engineering diagram that has managed without
 * one. Projecting the hang points through the same camera and letting the PDF
 * set the type keeps the labels crisp at whatever size the page uses them.
 */
function projectLabels(project: Project, camera: Camera): PlotLabel[] {
  const labels: PlotLabel[] = [];
  const point = new Vector3();

  for (const fixture of project.fixtures) {
    point.set(fixture.position.x, fixture.position.y, fixture.position.z).project(camera);
    // z outside -1..1 is behind the camera or past the far plane.
    if (point.z < -1 || point.z > 1) continue;

    const u = (point.x + 1) / 2;
    const v = (1 - point.y) / 2;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;

    labels.push({ text: fixture.channel, u, v });
  }

  return labels;
}
