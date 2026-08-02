/**
 * The solver worker.
 *
 * The whole solve happens here — prepare, sample, accumulate, measure — so the
 * main thread stays free while you drag a fixture. The worker imports the same
 * `domain/` modules the UI does; there is no duplicated maths.
 *
 * Messages carry the project document rather than prepared fixtures, because
 * `prepareRig` is where the rig's *issues* are found and those have to come
 * back with the result anyway.
 */

import { modelIndex, prepareRig, type RigIssue } from '../domain/rig';
import { computeMetrics, findBlobs } from '../domain/metrics';
import { buildSampleField, solve } from '../domain/solver';
import { FIXTURE_LIBRARY } from '../data/fixtures';
import type { Blob, Grid, Metrics, Project } from '../domain/types';

export interface SolveRequest {
  /** Echoed back so a stale reply can be dropped. */
  seq: number;
  project: Project;
}

export interface SolveReply {
  seq: number;
  grid: { cols: number; rows: number; originX: number; originY: number; spacing: number };
  /** Transferred, not copied. */
  lux: Float32Array;
  metrics: Metrics;
  blobs: Blob[];
  perFixtureAvg: number[];
  fixtureIds: string[];
  issues: RigIssue[];
  elapsedMs: number;
}

self.onmessage = (event: MessageEvent<SolveRequest>) => {
  const { seq, project } = event.data;

  const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
  const { fixtures, issues } = prepareRig(project, models);

  const field = buildSampleField(project.stage, project.plane);
  const { grid, perFixtureAvg, elapsedMs } = solve(fixtures, field);

  const metrics = computeMetrics(grid, project.targets);
  const blobs = findBlobs(grid, project.targets);

  const reply: SolveReply = {
    seq,
    grid: {
      cols: grid.cols,
      rows: grid.rows,
      originX: grid.originX,
      originY: grid.originY,
      spacing: grid.spacing,
    },
    lux: grid.lux,
    metrics,
    blobs,
    perFixtureAvg,
    fixtureIds: fixtures.map((f) => f.id),
    issues,
    elapsedMs,
  };

  // Transfer the grid's buffer rather than copying it. At a 0.05 m resolution
  // over a big stage this is a megabyte a frame, and copying it shows up as
  // jank on the drag it was meant to keep smooth.
  (self as unknown as Worker).postMessage(reply, [reply.lux.buffer]);
};

/** Re-exported so callers can rebuild a `Grid` without importing the worker. */
export type { Grid };
