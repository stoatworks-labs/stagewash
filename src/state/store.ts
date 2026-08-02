/**
 * The single zustand store: the project document, the selection, the last solve,
 * and the view options.
 *
 * The project is treated as an immutable value. Every mutation produces a new
 * `Project` and pushes the previous one onto the undo stack, which is what makes
 * undo a two-line operation instead of a subsystem. Rigs are a few hundred
 * fixtures of plain JSON at most, so snapshotting is cheaper than the machinery
 * that would avoid it.
 */

import { create } from 'zustand';

import { resolvePosition } from '../domain/rig';
import type { RigIssue } from '../domain/rig';
import type { Unit } from '../domain/metrics';
import type {
  Blob,
  FixtureModel,
  Grid,
  Metrics,
  Project,
  RigFixture,
  Stage,
  Structure,
  Targets,
  MeasurementPlane,
  Vec3,
} from '../domain/types';
import { defaultProject, emptyProject } from './defaultProject';
import { startSolver } from './solverClient';

export interface ViewOptions {
  showHeatmap: boolean;
  showBeams: boolean;
  showFootprints: boolean;
  showGrid: boolean;
  showLabels: boolean;
  /** Beam cone opacity, 0..1. */
  beamOpacity: number;
  /** Clamp the heatmap's top end here instead of at the maximum, lux. */
  scaleMaxLux: number | null;
  /** Only draw beams for the selected fixtures. */
  isolateSelection: boolean;
}

export interface SolveState {
  grid: Grid | null;
  metrics: Metrics | null;
  blobs: Blob[];
  perFixtureAvg: Map<string, number>;
  issues: RigIssue[];
  elapsedMs: number;
  solving: boolean;
}

interface StoreState {
  project: Project;
  past: Project[];
  future: Project[];

  selection: string[];
  selectedStructureId: string | null;

  solveState: SolveState;
  unit: Unit;
  view: ViewOptions;

  // --- project-level ---
  newProject: () => void;
  loadProject: (project: Project) => void;
  setName: (name: string) => void;
  setStage: (stage: Partial<Stage>) => void;
  setPlane: (plane: Partial<MeasurementPlane>) => void;
  setTargets: (targets: Partial<Targets>) => void;

  // --- structures ---
  addStructure: (structure: Structure) => void;
  updateStructure: (id: string, patch: Partial<Structure>) => void;
  removeStructure: (id: string) => void;
  selectStructure: (id: string | null) => void;

  // --- fixtures ---
  addFixtures: (fixtures: RigFixture[]) => void;
  updateFixture: (id: string, patch: Partial<RigFixture>) => void;
  updateSelected: (patch: Partial<RigFixture>) => void;
  removeSelected: () => void;
  duplicateSelected: () => void;
  select: (ids: string[]) => void;
  toggleSelect: (id: string, additive: boolean) => void;
  selectAll: () => void;

  // --- custom models ---
  addCustomModel: (model: FixtureModel) => void;
  removeCustomModel: (id: string) => void;

  // --- view + units ---
  setUnit: (unit: Unit) => void;
  setView: (patch: Partial<ViewOptions>) => void;

  undo: () => void;
  redo: () => void;

  /** Called by the solver client when a reply lands. */
  applySolve: (state: Partial<SolveState>) => void;
}

const MAX_UNDO = 60;

/**
 * Re-derive every fixture's world position from its structure.
 *
 * Position is cached on the fixture so the renderer and the exporters do not
 * each have to resolve it, which means it has to be refreshed whenever a
 * structure moves or a fixture slides along one. Doing it centrally here is the
 * only way it cannot be forgotten at a call site.
 */
function withResolvedPositions(project: Project): Project {
  const structures = new Map(project.structures.map((s) => [s.id, s]));
  return {
    ...project,
    fixtures: project.fixtures.map((fixture) => ({
      ...fixture,
      position: resolvePosition(fixture, structures.get(fixture.structureId)),
    })),
  };
}

export const useStore = create<StoreState>((set, get) => {
  const solver = startSolver((partial) => get().applySolve(partial));

  /** Commit a new project state: resolve positions, push undo, re-solve. */
  const commit = (next: Project): void => {
    const resolved = withResolvedPositions(next);
    const { project: previous, past } = get();
    set({
      project: resolved,
      past: [...past.slice(-(MAX_UNDO - 1)), previous],
      future: [],
      solveState: { ...get().solveState, solving: true },
    });
    solver.request(resolved);
  };

  /** Apply a patch to the current project. */
  const patchProject = (patch: Partial<Project>): void => {
    commit({ ...get().project, ...patch });
  };

  const initial = withResolvedPositions(defaultProject());

  // Kick off the first solve as soon as the store exists.
  queueMicrotask(() => solver.request(get().project));

  return {
    project: initial,
    past: [],
    future: [],

    selection: [],
    selectedStructureId: null,

    solveState: {
      grid: null,
      metrics: null,
      blobs: [],
      perFixtureAvg: new Map(),
      issues: [],
      elapsedMs: 0,
      solving: true,
    },
    unit: 'lux',
    view: {
      showHeatmap: true,
      showBeams: true,
      showFootprints: true,
      showGrid: true,
      showLabels: false,
      // Low on purpose. The cones are additively blended, so a dozen of them
      // crossing over the acting area sum to white and bleach out the heatmap
      // underneath — which is the thing the user is actually trying to read.
      // 0.045 keeps the beams legible as geometry without competing with the
      // data. The View panel's slider goes up for anyone who wants the
      // theatrical look.
      beamOpacity: 0.045,
      scaleMaxLux: null,
      isolateSelection: false,
    },

    newProject: () => {
      commit(emptyProject());
      set({ selection: [], selectedStructureId: null });
    },

    loadProject: (project) => {
      commit(project);
      set({ selection: [], selectedStructureId: null });
    },

    setName: (name) => patchProject({ name }),

    setStage: (stage) => patchProject({ stage: { ...get().project.stage, ...stage } }),

    setPlane: (plane) => patchProject({ plane: { ...get().project.plane, ...plane } }),

    setTargets: (targets) => patchProject({ targets: { ...get().project.targets, ...targets } }),

    addStructure: (structure) =>
      patchProject({ structures: [...get().project.structures, structure] }),

    updateStructure: (id, patch) =>
      patchProject({
        structures: get().project.structures.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      }),

    removeStructure: (id) => {
      const { project } = get();
      // Fixtures hung on a structure that is going away have to go with it, or
      // they become unsolvable orphans that the rig report complains about
      // forever.
      commit({
        ...project,
        structures: project.structures.filter((s) => s.id !== id),
        fixtures: project.fixtures.filter((f) => f.structureId !== id),
      });
      set({ selectedStructureId: null });
    },

    selectStructure: (id) => set({ selectedStructureId: id, selection: [] }),

    addFixtures: (fixtures) => {
      patchProject({ fixtures: [...get().project.fixtures, ...fixtures] });
      set({ selection: fixtures.map((f) => f.id) });
    },

    updateFixture: (id, patch) =>
      patchProject({
        fixtures: get().project.fixtures.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      }),

    updateSelected: (patch) => {
      const { selection, project } = get();
      if (selection.length === 0) return;
      const ids = new Set(selection);
      patchProject({
        fixtures: project.fixtures.map((f) => (ids.has(f.id) ? { ...f, ...patch } : f)),
      });
    },

    removeSelected: () => {
      const { selection, project } = get();
      if (selection.length === 0) return;
      const ids = new Set(selection);
      commit({ ...project, fixtures: project.fixtures.filter((f) => !ids.has(f.id)) });
      set({ selection: [] });
    },

    duplicateSelected: () => {
      const { selection, project } = get();
      if (selection.length === 0) return;
      const ids = new Set(selection);
      const stamp = Date.now().toString(36);
      const copies = project.fixtures
        .filter((f) => ids.has(f.id))
        .map((f, i) => ({
          ...f,
          id: `${f.id}-copy-${stamp}-${i}`,
          channel: `${f.channel}'`,
          // Offset along the bar so the copy is visible rather than hidden
          // exactly behind the original.
          along: f.along + 0.5,
        }));
      commit({ ...project, fixtures: [...project.fixtures, ...copies] });
      set({ selection: copies.map((c) => c.id) });
    },

    select: (ids) => set({ selection: ids, selectedStructureId: null }),

    toggleSelect: (id, additive) => {
      const { selection } = get();
      if (!additive) {
        set({ selection: [id], selectedStructureId: null });
        return;
      }
      set({
        selection: selection.includes(id)
          ? selection.filter((s) => s !== id)
          : [...selection, id],
        selectedStructureId: null,
      });
    },

    selectAll: () => set({ selection: get().project.fixtures.map((f) => f.id) }),

    addCustomModel: (model) =>
      patchProject({ customModels: [...get().project.customModels, model] }),

    removeCustomModel: (id) =>
      patchProject({ customModels: get().project.customModels.filter((m) => m.id !== id) }),

    setUnit: (unit) => set({ unit }),

    setView: (patch) => set({ view: { ...get().view, ...patch } }),

    undo: () => {
      const { past, project, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        project: previous,
        past: past.slice(0, -1),
        future: [project, ...future].slice(0, MAX_UNDO),
        solveState: { ...get().solveState, solving: true },
      });
      solver.request(previous);
    },

    redo: () => {
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      set({
        project: next,
        past: [...past, project],
        future: future.slice(1),
        solveState: { ...get().solveState, solving: true },
      });
      solver.request(next);
    },

    applySolve: (partial) =>
      set((state) => ({ solveState: { ...state.solveState, ...partial, solving: false } })),
  };
});

/** Structures indexed by id, for components that need a lookup. */
export const selectStructureMap = (state: StoreState): Map<string, Structure> =>
  new Map(state.project.structures.map((s) => [s.id, s]));

export const selectSelectedFixtures = (state: StoreState): RigFixture[] => {
  const ids = new Set(state.selection);
  return state.project.fixtures.filter((f) => ids.has(f.id));
};

/** Centre of the stage at deck level — the default aim for a new fixture. */
export const stageCentre = (project: Project): Vec3 => ({
  x: 0,
  y: project.stage.depthM / 2,
  z: project.stage.heightM,
});
