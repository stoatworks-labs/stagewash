/**
 * Report data shared by every output format, plus the CSV builders.
 *
 * Deliberately free of any jsPDF import. jsPDF drags in html2canvas and
 * dompurify — about 380 kB before gzip — and a user who never presses "PDF
 * report" should never download it. `pdf.ts` is imported dynamically at the
 * moment the button is pressed; keeping the shared types here is what makes
 * that split possible.
 */

import { panTiltToAim } from '../domain/geometry';
import { luxToFootcandles, type Unit } from '../domain/metrics';
import { findOptic, modelIndex } from '../domain/rig';
import type { RigIssue } from '../domain/rig';
import { FIXTURE_LIBRARY, KIND_LABELS } from '../data/fixtures';
import type { Blob as LevelBlob, Grid, Metrics, Project } from '../domain/types';

export const MODEL_CAVEAT = [
  'This is a direct illuminance calculation: inverse square, the cosine law, and each',
  'fixture’s intensity distribution. It does NOT model inter-reflection from the deck,',
  'walls or a cyc; atmospheric haze; shutter cuts, gobos or barn doors; or shadowing by',
  'people and scenery. On a dark stage that is the right model. In a white studio,',
  'inter-reflection can add a third again to these figures.',
].join(' ');

export interface ReportInput {
  project: Project;
  grid: Grid;
  metrics: Metrics;
  blobs: LevelBlob[];
  perFixtureAvg: Map<string, number>;
  issues: RigIssue[];
  unit: Unit;
  /**
   * The top of the colour scale, if the user has pinned one. Carried into the
   * report so its plots and its legend are on the same scale as the screen —
   * a pinned scale is usually pinned in order to compare two rigs, and a
   * report that quietly went back to autoscaling would break the comparison.
   */
  scaleMaxLux: number | null;
}

/** The raw grid, one row per sample, for anyone who wants to do their own maths. */
export function buildGridCsv(input: ReportInput): string {
  const { grid, unit, project } = input;
  const rows: string[] = [];

  rows.push(`# stagewash grid export — ${project.name}`);
  rows.push(`# ${new Date().toISOString()}`);
  rows.push(
    `# plane: ${project.plane.orientation} at ${project.plane.heightM} m, grid ${grid.spacing} m`,
  );
  rows.push(`# ${MODEL_CAVEAT}`);
  rows.push(`x_m,y_m,${unit === 'fc' ? 'footcandles' : 'lux'}`);

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const value = grid.lux[r * grid.cols + c] as number;
      const out = unit === 'fc' ? luxToFootcandles(value) : value;
      rows.push(
        `${(grid.originX + c * grid.spacing).toFixed(3)},${(grid.originY + r * grid.spacing).toFixed(3)},${out.toFixed(2)}`,
      );
    }
  }

  return rows.join('\n');
}

/** The fixture schedule as CSV, for pasting into a paperwork tool. */
export function buildScheduleCsv(input: ReportInput): string {
  const { project, unit, perFixtureAvg } = input;
  const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
  const structures = new Map(project.structures.map((s) => [s.id, s]));

  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const rows = [
    [
      'channel',
      'structure',
      'manufacturer',
      'fixture',
      'kind',
      'optic',
      'x_m',
      'y_m',
      'z_m',
      'aim_x_m',
      'aim_y_m',
      'aim_z_m',
      'pan_deg',
      'tilt_deg',
      'roll_deg',
      'zoom_deg',
      'level_pct',
      'transmission_pct',
      'gel',
      'watts',
      'weight_kg',
      'provenance',
      `avg_${unit === 'fc' ? 'fc' : 'lux'}`,
    ].join(','),
  ];

  for (const f of project.fixtures) {
    const model = models.get(f.modelId);
    const optic = model ? findOptic(model, f.opticId) : undefined;
    const { pan, tilt } = panTiltToAim(f.position, f.aim);
    const contribution = perFixtureAvg.get(f.id);
    const out = contribution === undefined ? '' : (unit === 'fc' ? luxToFootcandles(contribution) : contribution).toFixed(2);

    rows.push(
      [
        escape(f.channel),
        escape(structures.get(f.structureId)?.name ?? ''),
        escape(model?.manufacturer ?? ''),
        escape(model?.name ?? f.modelId),
        escape(model ? KIND_LABELS[model.kind] : ''),
        escape(optic?.label ?? ''),
        f.position.x.toFixed(3),
        f.position.y.toFixed(3),
        f.position.z.toFixed(3),
        f.aim.x.toFixed(3),
        f.aim.y.toFixed(3),
        f.aim.z.toFixed(3),
        pan.toFixed(1),
        tilt.toFixed(1),
        f.roll.toFixed(1),
        f.zoom !== undefined ? f.zoom.toFixed(1) : '',
        (f.level * 100).toFixed(0),
        (f.transmission * 100).toFixed(0),
        escape(f.gelName ?? ''),
        String(model?.watts ?? ''),
        String(model?.weightKg ?? ''),
        optic?.photometrics.provenance ?? '',
        out,
      ].join(','),
    );
  }

  return rows.join('\n');
}

/** Trigger a browser download. */
export function download(filename: string, content: string | Blob, type = 'text/plain'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the navigation to have started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFilename = (name: string): string =>
  name.replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '-').slice(0, 60) || 'stagewash';
