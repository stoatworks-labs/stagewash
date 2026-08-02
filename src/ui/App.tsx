/**
 * The shell: toolbar, three panes, and the metrics strip along the bottom.
 */

import { useEffect, useState } from 'react';

import { formatLevel, unitLabel } from '../domain/metrics';
import {
  buildGridCsv,
  buildScheduleCsv,
  download,
  safeFilename,
} from '../export/common';
import type { Project } from '../domain/types';
import { useStore } from '../state/store';
import { InspectorPanel } from './InspectorPanel';
import { LibraryDialog } from './LibraryDialog';
import { RigPanel } from './RigPanel';
import { Viewport } from './Viewport';

export function App(): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [buildingPdf, setBuildingPdf] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const project = useStore((s) => s.project);
  const unit = useStore((s) => s.unit);
  const setUnit = useStore((s) => s.setUnit);
  const setName = useStore((s) => s.setName);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const newProject = useStore((s) => s.newProject);
  const loadProject = useStore((s) => s.loadProject);
  const removeSelected = useStore((s) => s.removeSelected);
  const duplicateSelected = useStore((s) => s.duplicateSelected);
  const selectAll = useStore((s) => s.selectAll);
  const solveState = useStore((s) => s.solveState);

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from a field the user is typing in.
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAll();
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelected();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeSelected();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectAll, duplicateSelected, removeSelected]);

  /**
   * The three.js camera lives inside `Viewport`, which listens for this event.
   *
   * A window event rather than a context or a ref: this is the only imperative
   * call that has to cross a component boundary in the whole app, and standing
   * up a context for one caller is more machinery than it earns.
   */
  const setView = (which: 'plan' | 'section' | 'iso'): void => {
    window.dispatchEvent(new CustomEvent('stagewash:view', { detail: which }));
  };

  const reportInput = () => {
    const { grid, metrics, blobs, perFixtureAvg, issues } = solveState;
    if (!grid || !metrics) return null;
    return { project, grid, metrics, blobs, perFixtureAvg, issues, unit };
  };

  const exportPdf = async (): Promise<void> => {
    const input = reportInput();
    if (!input) return;
    setBuildingPdf(true);
    try {
      // Dynamic: jsPDF and its html2canvas/dompurify dependencies are ~380 kB
      // that a user who never exports a PDF should never download.
      const { buildPdf } = await import('../export/pdf');
      buildPdf(input).save(`${safeFilename(project.name)}-report.pdf`);
    } finally {
      setBuildingPdf(false);
    }
  };

  const exportCsv = (): void => {
    const input = reportInput();
    if (!input) return;
    download(`${safeFilename(project.name)}-grid.csv`, buildGridCsv(input), 'text/csv');
  };

  const exportSchedule = (): void => {
    const input = reportInput();
    if (!input) return;
    download(`${safeFilename(project.name)}-schedule.csv`, buildScheduleCsv(input), 'text/csv');
  };

  const saveProject = (): void => {
    download(
      `${safeFilename(project.name)}.stagewash.json`,
      JSON.stringify(project, null, 2),
      'application/json',
    );
  };

  const openProject = (file: File | undefined): void => {
    if (!file) return;
    setOpenError(null);
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Project;
        if (parsed.version !== 1 || !Array.isArray(parsed.fixtures)) {
          throw new Error('Not a stagewash project file.');
        }
        loadProject(parsed);
      } catch (cause) {
        // Inline rather than alert(): a modal dialog is suppressed outright in
        // some embedded browsers, so the failure would be silent — and a
        // silently-ignored Open looks exactly like a project that loaded and
        // happened to be empty.
        setOpenError(
          `Could not open ${file.name} — ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
  };

  return (
    <div className="app">
      <div className="toolbar">
        <div className="brand">
          stagewash<span>coverage calculator</span>
        </div>

        <input
          type="text"
          value={project.name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 180 }}
          aria-label="Project name"
        />

        <div className="toolbar-group">
          <button onClick={() => setAdding(true)} className="primary">
            + Fixtures
          </button>
        </div>

        <div className="toolbar-group">
          <button className="icon" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="icon" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
            ↷
          </button>
        </div>

        <div className="toolbar-group">
          <button onClick={() => setView('iso')}>Iso</button>
          <button onClick={() => setView('plan')}>Plan</button>
          <button onClick={() => setView('section')}>Section</button>
        </div>

        <div className="toolbar-group">
          <button className={unit === 'lux' ? 'active' : ''} onClick={() => setUnit('lux')}>
            lux
          </button>
          <button className={unit === 'fc' ? 'active' : ''} onClick={() => setUnit('fc')}>
            fc
          </button>
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <button onClick={newProject}>New</button>
          <label className="button-like">
            <button onClick={() => document.getElementById('open-project')?.click()}>Open</button>
            <input
              id="open-project"
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => openProject(e.target.files?.[0])}
            />
          </label>
          <button onClick={saveProject}>Save</button>
        </div>

        <div className="toolbar-group">
          <button onClick={() => void exportPdf()} disabled={!solveState.grid || buildingPdf}>
            {buildingPdf ? 'Building…' : 'PDF report'}
          </button>
          <button onClick={exportSchedule} disabled={!solveState.grid}>
            Schedule CSV
          </button>
          <button onClick={exportCsv} disabled={!solveState.grid}>
            Grid CSV
          </button>
        </div>
      </div>

      {openError && (
        <div className="err-box" style={{ margin: '8px 12px' }}>
          {openError}{' '}
          <button onClick={() => setOpenError(null)} style={{ marginLeft: 8 }}>
            Dismiss
          </button>
        </div>
      )}

      <div className="workspace">
        <RigPanel />
        <Viewport />
        <InspectorPanel />
      </div>

      <MetricsStrip />

      {adding && <LibraryDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function MetricsStrip(): React.ReactElement {
  const metrics = useStore((s) => s.solveState.metrics);
  const blobs = useStore((s) => s.solveState.blobs);
  const targets = useStore((s) => s.project.targets);
  const unit = useStore((s) => s.unit);

  if (!metrics) {
    return (
      <div className="metrics">
        <div className="metric">
          <div className="metric-label">status</div>
          <div className="metric-value">solving…</div>
        </div>
      </div>
    );
  }

  const u = unitLabel(unit);
  const uniformityOk = metrics.uniformityMinAvg >= targets.minUniformity;
  const coverageOk = metrics.coverage >= 0.9;
  const dark = blobs.filter((b) => b.kind === 'dark').length;
  const hot = blobs.filter((b) => b.kind === 'hot').length;

  return (
    <div className="metrics">
      <Metric label="average" value={formatLevel(metrics.avg, unit)} unit={u} />
      <Metric label="min" value={formatLevel(metrics.min, unit)} unit={u} />
      <Metric label="max" value={formatLevel(metrics.max, unit)} unit={u} />
      <Metric
        label="min : avg"
        value={metrics.uniformityMinAvg.toFixed(2)}
        tone={uniformityOk ? 'good' : 'bad'}
      />
      <Metric label="min : max" value={metrics.uniformityMinMax.toFixed(2)} />
      <Metric
        label="at target"
        value={`${(metrics.coverage * 100).toFixed(0)}`}
        unit="%"
        tone={coverageOk ? 'good' : 'bad'}
      />
      <Metric label="dark spots" value={String(dark)} tone={dark === 0 ? 'good' : 'bad'} />
      <Metric label="hot spots" value={String(hot)} tone={hot === 0 ? 'good' : 'bad'} />
      <div className="metric" style={{ flex: 1, minWidth: 200 }}>
        <div className="metric-label">note</div>
        <div className="small faint">
          Direct illuminance only — no bounce, haze, cuts or shadowing.
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'good' | 'bad';
}): React.ReactElement {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone ?? ''}`}>
        {value}
        {unit ? <span className="metric-unit">{unit}</span> : null}
      </div>
    </div>
  );
}
