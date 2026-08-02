/**
 * Right pane: the fixture inspector, the measurement setup, and the results.
 */

import { useMemo } from 'react';

import { panTiltToAim, runLength } from '../domain/geometry';
import { formatLevel, LEVEL_PRESETS, unitLabel } from '../domain/metrics';
import {
  clampZoom,
  fieldAngleToCover,
  findOptic,
  isZoomable,
  modelIndex,
} from '../domain/rig';
import { fieldAngleOf } from '../domain/photometry/distribution';
import { FIXTURE_LIBRARY, KIND_LABELS } from '../data/fixtures';
import type { RigFixture } from '../domain/types';
import { useStore } from '../state/store';
import { Checkbox, NumberField, ProvenanceBadge, Section, SliderField } from './Section';

export function InspectorPanel(): React.ReactElement {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const unit = useStore((s) => s.unit);
  const updateSelected = useStore((s) => s.updateSelected);
  const removeSelected = useStore((s) => s.removeSelected);
  const duplicateSelected = useStore((s) => s.duplicateSelected);
  const setPlane = useStore((s) => s.setPlane);
  const setTargets = useStore((s) => s.setTargets);
  const setStage = useStore((s) => s.setStage);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const issues = useStore((s) => s.solveState.issues);

  const models = useMemo(
    () => modelIndex(FIXTURE_LIBRARY, project.customModels),
    [project.customModels],
  );

  const selectedFixtures = project.fixtures.filter((f) => selection.includes(f.id));
  const first = selectedFixtures[0];

  return (
    <div className="pane">
      {first ? (
        <FixtureInspector
          fixture={first}
          count={selectedFixtures.length}
          models={models}
          onChange={updateSelected}
          onDelete={removeSelected}
          onDuplicate={duplicateSelected}
        />
      ) : (
        <div className="empty">
          Nothing selected.
          <br />
          Click a fixture in the plot or the rig list.
        </div>
      )}

      <Section title="Stage">
        <div className="field-row">
          <NumberField
            label="Width"
            suffix="m"
            value={project.stage.widthM}
            min={1}
            step={0.5}
            onChange={(widthM) => setStage({ widthM })}
          />
          <NumberField
            label="Depth"
            suffix="m"
            value={project.stage.depthM}
            min={1}
            step={0.5}
            onChange={(depthM) => setStage({ depthM })}
          />
        </div>
        <NumberField
          label="Deck height"
          suffix="m"
          value={project.stage.heightM}
          step={0.1}
          onChange={(heightM) => setStage({ heightM })}
        />
      </Section>

      <Section title="Measurement plane">
        <div>
          <label>Surface</label>
          <select
            value={project.plane.orientation}
            onChange={(e) =>
              setPlane({ orientation: e.target.value as 'horizontal' | 'vertical' })
            }
          >
            <option value="horizontal">Horizontal — light on the deck</option>
            <option value="vertical">Vertical — light on a face</option>
          </select>
        </div>

        <div className="provenance-note">
          {project.plane.orientation === 'horizontal'
            ? 'Illuminance on a surface parallel to the deck. Set the height to 0 for a floor wash, or 1.5 m for head height.'
            : 'Illuminance on a surface facing the audience. A fixture directly overhead contributes almost nothing to this, which is how you catch a rig with plenty of top light and no front light.'}
        </div>

        <div className="field-row">
          <NumberField
            label="Height"
            suffix="m"
            value={project.plane.heightM}
            step={0.1}
            min={0}
            onChange={(heightM) => setPlane({ heightM })}
          />
          <NumberField
            label="Resolution"
            suffix="m"
            value={project.plane.resolutionM}
            step={0.05}
            min={0.05}
            max={2}
            onChange={(resolutionM) => setPlane({ resolutionM })}
          />
        </div>

        <div className="inline">
          <button onClick={() => setPlane({ orientation: 'horizontal', heightM: 0 })}>
            Floor wash
          </button>
          <button onClick={() => setPlane({ orientation: 'vertical', heightM: 1.5 })}>
            Face light
          </button>
        </div>
      </Section>

      <Section title="Target">
        <div>
          <label>Preset</label>
          <select
            value=""
            onChange={(e) => {
              const preset = LEVEL_PRESETS.find((p) => p.name === e.target.value);
              if (preset) setTargets({ targetLux: preset.lux });
            }}
          >
            <option value="">— choose —</option>
            {LEVEL_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.lux} lux
              </option>
            ))}
          </select>
        </div>

        <NumberField
          label="Design level"
          suffix={unitLabel(unit)}
          value={unit === 'fc' ? project.targets.targetLux / 10.7639 : project.targets.targetLux}
          step={unit === 'fc' ? 5 : 50}
          min={1}
          onChange={(value) =>
            setTargets({ targetLux: unit === 'fc' ? value * 10.7639 : value })
          }
        />

        <div className="field-row">
          <NumberField
            label="Dark below"
            suffix="× target"
            value={project.targets.darkFraction}
            step={0.05}
            min={0.05}
            max={1}
            onChange={(darkFraction) => setTargets({ darkFraction })}
          />
          <NumberField
            label="Hot above"
            suffix="× target"
            value={project.targets.hotMultiple}
            step={0.1}
            min={1}
            onChange={(hotMultiple) => setTargets({ hotMultiple })}
          />
        </div>
      </Section>

      <Section title="View" defaultOpen={false}>
        <Checkbox
          label="Heatmap"
          checked={view.showHeatmap}
          onChange={(showHeatmap) => setView({ showHeatmap })}
        />
        <Checkbox label="Beams" checked={view.showBeams} onChange={(showBeams) => setView({ showBeams })} />
        <Checkbox
          label="Footprints"
          checked={view.showFootprints}
          onChange={(showFootprints) => setView({ showFootprints })}
        />
        <Checkbox label="Grid" checked={view.showGrid} onChange={(showGrid) => setView({ showGrid })} />
        <Checkbox
          label="Only show selected beams"
          checked={view.isolateSelection}
          onChange={(isolateSelection) => setView({ isolateSelection })}
        />
        <SliderField
          label="Beam density"
          value={view.beamOpacity}
          min={0.02}
          max={0.4}
          step={0.01}
          onChange={(beamOpacity) => setView({ beamOpacity })}
          format={(v) => v.toFixed(2)}
        />
        <div>
          <label>Scale top</label>
          <div className="inline">
            <input
              type="number"
              value={view.scaleMaxLux ?? ''}
              placeholder="auto (98th pct)"
              onChange={(e) => {
                const value = Number(e.target.value);
                setView({ scaleMaxLux: e.target.value === '' || !Number.isFinite(value) ? null : value });
              }}
            />
            <button onClick={() => setView({ scaleMaxLux: null })}>Auto</button>
          </div>
        </div>
      </Section>

      {issues.length > 0 && (
        <Section title={`Rig checks (${issues.length})`}>
          <div style={{ margin: '-10px' }}>
            {issues.map((issue, i) => (
              <div key={i} className={`issue ${issue.severity}`}>
                <span className="issue-mark">{issue.severity === 'error' ? '✕' : '!'}</span>
                <span>{issue.message}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function FixtureInspector({
  fixture,
  count,
  models,
  onChange,
  onDelete,
  onDuplicate,
}: {
  fixture: RigFixture;
  count: number;
  models: Map<string, import('../domain/types').FixtureModel>;
  onChange: (patch: Partial<RigFixture>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}): React.ReactElement {
  const project = useStore((s) => s.project);
  const unit = useStore((s) => s.unit);
  const perFixtureAvg = useStore((s) => s.solveState.perFixtureAvg);

  const model = models.get(fixture.modelId);
  const optic = model ? findOptic(model, fixture.opticId) : undefined;
  const structure = project.structures.find((s) => s.id === fixture.structureId);
  const barLength = structure ? runLength(structure.from, structure.to) : 0;

  const { pan, tilt } = panTiltToAim(fixture.position, fixture.aim);
  const throwDistance = Math.hypot(
    fixture.aim.x - fixture.position.x,
    fixture.aim.y - fixture.position.y,
    fixture.aim.z - fixture.position.z,
  );

  const zoomable = model && optic ? isZoomable(model, optic) : false;
  const currentZoom =
    fixture.zoom ??
    (optic?.photometrics.photometry.kind === 'analytic'
      ? fieldAngleOf(optic.photometrics.photometry)
      : (optic?.photometrics.fieldAngle ?? 25));

  const contribution = perFixtureAvg.get(fixture.id);

  return (
    <Section
      title={count > 1 ? `${count} fixtures selected` : `Channel ${fixture.channel}`}
      aside={optic ? <ProvenanceBadge provenance={optic.photometrics.provenance} /> : null}
    >
      <div className="small">
        <strong>{model ? `${model.manufacturer} ${model.name}` : fixture.modelId}</strong>
        {model ? <span className="faint"> · {KIND_LABELS[model.kind]}</span> : null}
        {optic ? <div className="faint">{optic.label}</div> : null}
      </div>

      {optic && (
        <div className="provenance-note">
          {optic.photometrics.source}
          <br />
          <span className="mono">
            {Math.round(optic.photometrics.peakCandela).toLocaleString()} cd ·{' '}
            {optic.photometrics.beamAngle.toFixed(0)}° beam ·{' '}
            {optic.photometrics.fieldAngle.toFixed(0)}° field
          </span>
        </div>
      )}

      {count === 1 && (
        <div className="field-row">
          <div>
            <label>Channel</label>
            <input
              type="text"
              value={fixture.channel}
              onChange={(e) => onChange({ channel: e.target.value })}
            />
          </div>
          <NumberField
            label="Along bar"
            suffix={`m of ${barLength.toFixed(1)}`}
            value={fixture.along}
            step={0.1}
            min={0}
            max={barLength}
            onChange={(along) => onChange({ along })}
          />
        </div>
      )}

      {model && model.optics.length > 1 && (
        <div>
          <label>Optic / lens</label>
          <select value={fixture.opticId} onChange={(e) => onChange({ opticId: e.target.value })}>
            {model.optics.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <hr />

      <div>
        <label>Focus</label>
        <select
          value={fixture.focusMode}
          onChange={(e) => {
            const mode = e.target.value as 'aim' | 'angles';
            // Switching to angles must not move the fixture, so seed pan/tilt
            // from where it is currently pointing.
            if (mode === 'angles') onChange({ focusMode: mode, pan, tilt });
            else onChange({ focusMode: mode });
          }}
        >
          <option value="aim">Aim at a point</option>
          <option value="angles">Pan / tilt</option>
        </select>
      </div>

      {fixture.focusMode === 'aim' ? (
        <>
          <div className="field-row-3">
            <NumberField label="Aim X" value={fixture.aim.x} onChange={(x) => onChange({ aim: { ...fixture.aim, x } })} />
            <NumberField label="Aim Y" value={fixture.aim.y} onChange={(y) => onChange({ aim: { ...fixture.aim, y } })} />
            <NumberField label="Aim Z" value={fixture.aim.z} onChange={(z) => onChange({ aim: { ...fixture.aim, z } })} />
          </div>
          <div className="provenance-note mono small">
            resolves to pan {pan.toFixed(1)}° · tilt {tilt.toFixed(1)}° · throw{' '}
            {throwDistance.toFixed(2)} m
          </div>
        </>
      ) : (
        <div className="field-row">
          <NumberField label="Pan" suffix="°" value={fixture.pan} step={1} onChange={(p) => onChange({ pan: p })} />
          <NumberField label="Tilt" suffix="°" value={fixture.tilt} step={1} onChange={(t) => onChange({ tilt: t })} />
        </div>
      )}

      <NumberField
        label="Roll (rotates an oval beam about its axis)"
        suffix="°"
        value={fixture.roll}
        step={15}
        onChange={(roll) => onChange({ roll })}
      />

      {zoomable && optic && (
        <>
          <SliderField
            label="Zoom (field angle)"
            value={currentZoom}
            min={optic.zoomMin ?? 5}
            max={optic.zoomMax ?? 60}
            step={0.5}
            format={(v) => `${v.toFixed(1)}°`}
            onChange={(zoom) => onChange({ zoom: clampZoom(optic, zoom) })}
          />
          <button
            onClick={() => {
              // Cover a 2 m circle at the aim point — roughly one performer's
              // working area, and the first thing anyone reaches for.
              const wanted = fieldAngleToCover(fixture.position, fixture.aim, 1.0);
              onChange({ zoom: clampZoom(optic, wanted) });
            }}
          >
            Zoom to cover 2 m at the aim
          </button>
        </>
      )}

      <hr />

      <SliderField
        label="Level"
        value={fixture.level}
        min={0}
        max={1}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(level) => onChange({ level })}
      />

      <SliderField
        label="Gel transmission"
        value={fixture.transmission}
        min={0.01}
        max={1}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(transmission) => onChange({ transmission })}
      />

      <div>
        <label>Gel / colour note</label>
        <input
          type="text"
          value={fixture.gelName ?? ''}
          placeholder="e.g. L201 — 22%"
          onChange={(e) => onChange({ gelName: e.target.value })}
        />
      </div>

      <Checkbox label="Enabled" checked={fixture.enabled} onChange={(enabled) => onChange({ enabled })} />

      {contribution !== undefined && (
        <div className="provenance-note">
          Contributes <span className="mono">{formatLevel(contribution, unit)}</span>{' '}
          {unitLabel(unit)} to the stage average on its own.
        </div>
      )}

      <div className="inline">
        <button onClick={onDuplicate}>Duplicate</button>
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </Section>
  );
}
