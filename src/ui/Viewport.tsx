/**
 * The 3D viewport: a canvas, the scene, orbit controls, and click-to-select.
 *
 * The scene is rebuilt from the store on change rather than diffed. A rig is a
 * few hundred line segments, so a full rebuild is under a millisecond and it
 * removes the whole class of bug where the view and the document disagree.
 */

import { useEffect, useMemo, useRef } from 'react';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { modelIndex, prepareRig } from '../domain/rig';
import { FIXTURE_LIBRARY } from '../data/fixtures';
import { createScene, type SceneHandle } from '../render/scene';
import { chooseScale, legendStops } from '../render/heatmap';
import { formatLevel, unitLabel } from '../domain/metrics';
import { useStore } from '../state/store';

export function Viewport(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  /** Set while the pointer is dragging, so a drag does not also select. */
  const draggedRef = useRef(false);

  const project = useStore((s) => s.project);
  // The setup effect runs once but needs the *current* stage when a view
  // button is pressed later, so it reads it through a ref rather than closing
  // over the value it happened to mount with.
  const stageRef = useRef(project.stage);
  stageRef.current = project.stage;
  const selection = useStore((s) => s.selection);
  const selectedStructureId = useStore((s) => s.selectedStructureId);
  const grid = useStore((s) => s.solveState.grid);
  const solving = useStore((s) => s.solveState.solving);
  const elapsedMs = useStore((s) => s.solveState.elapsedMs);
  const view = useStore((s) => s.view);
  const unit = useStore((s) => s.unit);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const select = useStore((s) => s.select);

  // --- set up once ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const scene = createScene(canvas);
    sceneRef.current = scene;

    const controls = new OrbitControls(scene.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * 0.98;
    controlsRef.current = controls;

    let frame = 0;
    const loop = (): void => {
      controls.update();
      scene.render();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = wrap;
      scene.resize(clientWidth, clientHeight);
    });
    observer.observe(wrap);
    scene.resize(wrap.clientWidth, wrap.clientHeight);

    // The camera has to be moved *and* the orbit target moved with it, or the
    // next drag snaps back to whatever the controls were still orbiting around.
    const applyView = (which: 'plan' | 'section' | 'iso'): void => {
      const { depthM } = stageRef.current;
      scene.setView(which);
      controls.target.set(0, depthM / 2, 0);
      controls.update();
    };

    const onViewEvent = (event: Event): void => {
      applyView((event as CustomEvent).detail as 'plan' | 'section' | 'iso');
    };
    window.addEventListener('stagewash:view', onViewEvent);
    applyView('iso');

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('stagewash:view', onViewEvent);
      controls.dispose();
      scene.dispose();
      sceneRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  // --- push document changes into the scene --------------------------------
  const prepared = useMemo(() => {
    const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
    return prepareRig(project, models).fixtures;
  }, [project]);

  useEffect(() => {
    sceneRef.current?.setProject(project, prepared, new Set(selection), selectedStructureId);
  }, [project, prepared, selection, selectedStructureId]);

  useEffect(() => {
    sceneRef.current?.setHeatmap(grid, view.scaleMaxLux, 'viridis');
  }, [grid, view.scaleMaxLux]);

  useEffect(() => {
    sceneRef.current?.setOptions({
      showHeatmap: view.showHeatmap,
      showBeams: view.showBeams,
      showFootprints: view.showFootprints,
      showGrid: view.showGrid,
      beamOpacity: view.beamOpacity,
      isolateSelection: view.isolateSelection,
    });
  }, [
    view.showHeatmap,
    view.showBeams,
    view.showFootprints,
    view.showGrid,
    view.beamOpacity,
    view.isolateSelection,
  ]);

  // --- picking -------------------------------------------------------------
  const onPointerDown = (): void => {
    draggedRef.current = false;
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    // Any real drag (more than a couple of pixels) is an orbit, not a click.
    if (event.buttons !== 0) draggedRef.current = true;
  };

  const onPointerUp = (event: React.PointerEvent): void => {
    if (draggedRef.current) return;
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return;

    const rect = canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const hit = scene.pick(ndcX, ndcY);
    if (hit) toggleSelect(hit, event.shiftKey || event.metaKey);
    else if (!event.shiftKey && !event.metaKey) select([]);
  };

  const scale = grid ? chooseScale(grid, view.scaleMaxLux) : null;
  const stops = scale ? legendStops(scale, 'viridis', 24) : [];
  const labelStops = scale ? legendStops(scale, 'viridis', 3) : [];

  return (
    <div className="viewport-wrap" ref={wrapRef}>
      <canvas
        className="viewport"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      <div className="viewport-hint">
        drag orbit · right-drag pan · scroll zoom · click select
      </div>

      <div className="viewport-badge">
        {solving ? 'solving…' : `solved in ${elapsedMs.toFixed(1)} ms`}
        {grid ? ` · ${grid.cols}×${grid.rows} @ ${grid.spacing.toFixed(2)} m` : ''}
      </div>

      {view.showHeatmap && scale && (
        <div className="legend">
          <div className="legend-bar">
            {stops.map((stop, i) => (
              <div key={i} style={{ background: stop.colour }} />
            ))}
          </div>
          <div className="legend-scale">
            {labelStops.map((stop, i) => (
              <span key={i}>{formatLevel(stop.lux, unit)}</span>
            ))}
          </div>
          <div className="legend-scale">
            <span className="faint">
              {project.plane.orientation === 'vertical' ? 'vertical / face' : 'horizontal'} @{' '}
              {project.plane.heightM.toFixed(2)} m · {unitLabel(unit)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
