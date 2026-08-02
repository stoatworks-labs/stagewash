/**
 * Left pane: the rig tree and the structures that make it up.
 */

import { useMemo, useState } from 'react';

import { runLength } from '../domain/geometry';
import { modelIndex } from '../domain/rig';
import { FIXTURE_LIBRARY } from '../data/fixtures';
import type { Structure, StructureKind } from '../domain/types';
import { useStore } from '../state/store';
import { NumberField, Section } from './Section';

const KIND_OPTIONS: Array<{ value: StructureKind; label: string }> = [
  { value: 'truss', label: 'Truss' },
  { value: 'scaff', label: 'Scaff / pipe' },
  { value: 'bar', label: 'Bar / LX' },
  { value: 'stand', label: 'Stand' },
  { value: 'floor', label: 'Floor' },
];

/** Manfrotto-class stand presets, so a stand has a realistic height limit. */
const STAND_PRESETS: Array<{ name: string; maxHeightM: number; swlKg: number }> = [
  { name: 'Wind-up stand, 3.7 m', maxHeightM: 3.7, swlKg: 60 },
  { name: 'Wind-up stand, 4.2 m', maxHeightM: 4.2, swlKg: 80 },
  { name: 'Wind-up stand, 5.4 m', maxHeightM: 5.4, swlKg: 60 },
  { name: 'Lighting stand, 2.8 m', maxHeightM: 2.8, swlKg: 20 },
];

export function RigPanel(): React.ReactElement {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const selectedStructureId = useStore((s) => s.selectedStructureId);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectStructure = useStore((s) => s.selectStructure);
  const addStructure = useStore((s) => s.addStructure);
  const updateStructure = useStore((s) => s.updateStructure);
  const removeStructure = useStore((s) => s.removeStructure);
  const updateFixture = useStore((s) => s.updateFixture);
  const perFixtureAvg = useStore((s) => s.solveState.perFixtureAvg);

  const models = useMemo(
    () => modelIndex(FIXTURE_LIBRARY, project.customModels),
    [project.customModels],
  );

  const selected = new Set(selection);
  const structure = project.structures.find((s) => s.id === selectedStructureId) ?? null;

  const addBar = (): void => {
    const index = project.structures.length + 1;
    addStructure({
      id: `bar-${Date.now().toString(36)}`,
      name: `LX${index}`,
      kind: 'truss',
      from: { x: -5, y: 4, z: 6 },
      to: { x: 5, y: 4, z: 6 },
      sizeM: 0.29,
      swlKg: 250,
    });
  };

  const addStand = (): void => {
    addStructure({
      id: `stand-${Date.now().toString(36)}`,
      name: `Stand ${project.structures.filter((s) => s.kind === 'stand').length + 1}`,
      kind: 'stand',
      from: { x: -6, y: 1, z: 0 },
      to: { x: -6, y: 1, z: 3.5 },
      maxHeightM: 4.2,
      swlKg: 80,
    });
  };

  return (
    <div className="pane">
      <Section
        title="Rig"
        aside={<span className="mono faint">{project.fixtures.length} fixtures</span>}
      >
        <div className="inline">
          <button onClick={addBar}>+ Bar / truss</button>
          <button onClick={addStand}>+ Stand</button>
        </div>
      </Section>

      {project.structures.map((s) => {
        const onIt = project.fixtures.filter((f) => f.structureId === s.id);
        const load = onIt.reduce((sum, f) => sum + (models.get(f.modelId)?.weightKg ?? 0), 0);

        return (
          <div className="tree-group" key={s.id}>
            <div
              className={`tree-structure ${s.id === selectedStructureId ? 'selected' : ''}`}
              onClick={() => selectStructure(s.id === selectedStructureId ? null : s.id)}
            >
              <span className="name-cell">{s.name}</span>
              <span className="tree-meta">
                {s.kind === 'stand'
                  ? `${Math.max(s.from.z, s.to.z).toFixed(1)} m`
                  : `${runLength(s.from, s.to).toFixed(1)} m @ ${s.from.z.toFixed(1)} m`}
                {load > 0 ? ` · ${load.toFixed(0)} kg` : ''}
              </span>
            </div>

            {onIt.map((fixture) => {
              const model = models.get(fixture.modelId);
              const contribution = perFixtureAvg.get(fixture.id);
              return (
                <div
                  key={fixture.id}
                  className={`tree-fixture ${selected.has(fixture.id) ? 'selected' : ''} ${
                    fixture.enabled ? '' : 'disabled'
                  }`}
                  onClick={(e) => toggleSelect(fixture.id, e.shiftKey || e.metaKey)}
                >
                  <span className="chan">{fixture.channel}</span>
                  <span className="name-cell" title={model?.name ?? fixture.modelId}>
                    {model?.name ?? fixture.modelId}
                  </span>
                  <span
                    className="tree-meta"
                    title="Average lux this fixture contributes across the whole stage"
                  >
                    <input
                      type="checkbox"
                      checked={fixture.enabled}
                      title="Enabled"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updateFixture(fixture.id, { enabled: e.target.checked })}
                    />
                    {contribution !== undefined && fixture.enabled
                      ? ` ${contribution.toFixed(0)}`
                      : ''}
                  </span>
                </div>
              );
            })}

            {onIt.length === 0 && (
              <div className="empty small">
                Nothing hung here. Select this bar and use Add fixtures.
              </div>
            )}
          </div>
        );
      })}

      {structure && <StructureEditor structure={structure} onRemove={removeStructure} onChange={updateStructure} />}
    </div>
  );
}

function StructureEditor({
  structure,
  onChange,
  onRemove,
}: {
  structure: Structure;
  onChange: (id: string, patch: Partial<Structure>) => void;
  onRemove: (id: string) => void;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const isStand = structure.kind === 'stand';

  const setFrom = (patch: Partial<{ x: number; y: number; z: number }>): void =>
    onChange(structure.id, { from: { ...structure.from, ...patch } });
  const setTo = (patch: Partial<{ x: number; y: number; z: number }>): void =>
    onChange(structure.id, { to: { ...structure.to, ...patch } });

  return (
    <Section title={`Structure — ${structure.name}`}>
      <div>
        <label>Name</label>
        <input
          type="text"
          value={structure.name}
          onChange={(e) => onChange(structure.id, { name: e.target.value })}
        />
      </div>

      <div>
        <label>Type</label>
        <select
          value={structure.kind}
          onChange={(e) => onChange(structure.id, { kind: e.target.value as StructureKind })}
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {isStand ? (
        <>
          <div className="field-row-3">
            <NumberField label="X" value={structure.from.x} onChange={(x) => { setFrom({ x }); setTo({ x }); }} />
            <NumberField label="Y" value={structure.from.y} onChange={(y) => { setFrom({ y }); setTo({ y }); }} />
            <NumberField
              label="Height"
              value={structure.to.z}
              min={0.5}
              onChange={(z) => setTo({ z })}
            />
          </div>

          <div>
            <label>Stand preset</label>
            <select
              value={structure.maxHeightM ?? ''}
              onChange={(e) => {
                const preset = STAND_PRESETS.find((p) => String(p.maxHeightM) === e.target.value);
                if (preset) {
                  onChange(structure.id, { maxHeightM: preset.maxHeightM, swlKg: preset.swlKg });
                }
              }}
            >
              <option value="">— custom —</option>
              {STAND_PRESETS.map((p) => (
                <option key={p.name} value={p.maxHeightM}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {structure.maxHeightM !== undefined && structure.to.z > structure.maxHeightM && (
            <div className="err-box">
              Set above the stand's rated {structure.maxHeightM.toFixed(1)} m.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="field-row-3">
            <NumberField label="X from" value={structure.from.x} onChange={(x) => setFrom({ x })} />
            <NumberField label="Y" value={structure.from.y} onChange={(y) => { setFrom({ y }); setTo({ y }); }} />
            <NumberField label="Z" value={structure.from.z} onChange={(z) => { setFrom({ z }); setTo({ z }); }} />
          </div>
          <NumberField label="X to" value={structure.to.x} onChange={(x) => setTo({ x })} />
          <div className="field-row">
            <NumberField
              label="Section"
              suffix="m"
              value={structure.sizeM ?? 0.29}
              step={0.01}
              onChange={(sizeM) => onChange(structure.id, { sizeM })}
            />
            <NumberField
              label="SWL"
              suffix="kg"
              value={structure.swlKg ?? 0}
              step={10}
              onChange={(swlKg) => onChange(structure.id, { swlKg })}
            />
          </div>
        </>
      )}

      {confirming ? (
        <div className="inline">
          <span className="small muted">Delete this and its fixtures?</span>
          <button className="danger" onClick={() => onRemove(structure.id)}>
            Delete
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <button className="danger" onClick={() => setConfirming(true)}>
          Delete structure
        </button>
      )}
    </Section>
  );
}
