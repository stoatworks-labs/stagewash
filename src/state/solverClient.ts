/**
 * Main-thread half of the solver.
 *
 * Two jobs beyond posting messages:
 *
 * 1. **Coalescing.** A drag fires an update per pointer move. Only the newest
 *    request matters, so while a solve is in flight the client keeps just the
 *    last project and posts it when the worker comes back. Queueing them all
 *    would make the heatmap lag further behind the further you drag.
 * 2. **Dropping stale replies.** Every request carries a sequence number and
 *    replies below the newest are discarded. Without it, an old cheap solve can
 *    land after a new expensive one and paint the previous rig.
 */

import type { SolveReply, SolveRequest } from '../workers/solve.worker';
import type { Project } from '../domain/types';
import type { SolveState } from './store';

export interface SolverHandle {
  request: (project: Project) => void;
  dispose: () => void;
}

export function startSolver(onResult: (state: Partial<SolveState>) => void): SolverHandle {
  const worker = new Worker(new URL('../workers/solve.worker.ts', import.meta.url), {
    type: 'module',
  });

  let seq = 0;
  /** Sequence number of the newest request posted. */
  let latest = 0;
  let busy = false;
  let pending: Project | null = null;

  const post = (project: Project): void => {
    seq += 1;
    latest = seq;
    busy = true;
    const message: SolveRequest = { seq, project };
    worker.postMessage(message);
  };

  worker.onmessage = (event: MessageEvent<SolveReply>) => {
    const reply = event.data;

    // A reply for anything but the newest request is stale by definition.
    if (reply.seq === latest) {
      const perFixtureAvg = new Map<string, number>();
      reply.fixtureIds.forEach((id, i) => perFixtureAvg.set(id, reply.perFixtureAvg[i] ?? 0));

      onResult({
        grid: { ...reply.grid, lux: reply.lux },
        metrics: reply.metrics,
        blobs: reply.blobs,
        perFixtureAvg,
        issues: reply.issues,
        elapsedMs: reply.elapsedMs,
        solving: false,
      });
    }

    busy = false;
    if (pending) {
      const next = pending;
      pending = null;
      post(next);
    }
  };

  worker.onerror = (event) => {
    // A worker that has died silently is indistinguishable from a rig that
    // happens to be dark, which is the worst possible failure for this app.
    console.error('[stagewash] solver worker failed', event.message || event);
    busy = false;
    onResult({ solving: false });
  };

  return {
    request: (project) => {
      // While a solve is running, keep only the newest request. Queueing every
      // pointer move would make the heatmap fall further behind the longer the
      // drag goes on.
      if (busy) pending = project;
      else post(project);
    },
    dispose: () => worker.terminate(),
  };
}
