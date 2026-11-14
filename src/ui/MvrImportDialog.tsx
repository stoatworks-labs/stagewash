/**
 * Import an MVR: choose what each fixture type in the file is, place the rig
 * over the stage, and replace the current rig with it.
 *
 * The type list is the point of this dialog. An MVR carries no photometry, so
 * every fixture type needs telling what it is before it can be solved, and the
 * dialog's job is to make that one choice per type quick and its consequences
 * plain — including when a GDTF's beam figures are placeholders, or absent.
 */

import { useMemo, useState } from 'react';

import { FIXTURE_LIBRARY } from '../data/fixtures';
import { modelIndex } from '../domain/rig';
import {
  buildRig,
  planExtent,
  suggestChoices,
  suggestOffset,
  type MvrDocument,
  type TypeChoice,
} from '../domain/mvr/importRig';
import type { FixtureModel, Project, Vec3 } from '../domain/types';
import { useStore } from '../state/store';
import { Checkbox, NumberField } from './Section';

const encode = (choice: TypeChoice): string =>
  choice.kind === 'model' ? JSON.stringify([choice.modelId, choice.opticId]) : choice.kind;

const decode = (value: string): TypeChoice => {
  if (value === 'skip' || value === 'gdtf') return { kind: value };
  const [modelId, opticId] = JSON.parse(value) as [string, string];
  return { kind: 'model', modelId, opticId };
};

const fmt = (v: number): string => v.toFixed(2);

export function MvrImportDialog({
  doc,
  fileName,
  onClose,
  onImported,
}: {
  doc: MvrDocument;
  fileName: string;
  onClose: () => void;
  /** Called with the notes the import produced, after the rig is replaced. */
  onImported: (notes: string[]) => void;
}): React.ReactElement {
  const project = useStore((s) => s.project);
  const loadProject = useStore((s) => s.loadProject);

  // Everything a type could be mapped to: the library, the project's own
  // models, and any custom models a stagewash export carried with it.
  const allModels = useMemo(() => {
    const carried = (doc.stagewash?.customModels ?? []).filter(
      (m) => !project.customModels.some((c) => c.id === m.id),
    );
    return [...project.customModels, ...carried, ...FIXTURE_LIBRARY];
  }, [doc, project.customModels]);
  // What the project can already use. Models carried in the file are found by
  // the importer itself and added to the project only if a fixture uses one.
  const models = useMemo(() => modelIndex(FIXTURE_LIBRARY, project.customModels), [project.customModels]);

  const [choices, setChoices] = useState(() => suggestChoices(doc, models));
  const [restore, setRestore] = useState(doc.stagewash !== undefined);
  const [offset, setOffset] = useState<Vec3>({ x: 0, y: 0, z: 0 });

  const restoredUuids = useMemo(() => {
    if (!restore || !doc.stagewash) return new Set<string>();
    const saved = doc.stagewash;
    return new Set(
      doc.scene.fixtures
        .filter((f) => {
          const s = saved.fixtures[f.uuid];
          return (
            s !== undefined &&
            (models.has(s.modelId) || saved.customModels.some((m) => m.id === s.modelId))
          );
        })
        .map((f) => f.uuid),
    );
  }, [doc, restore, models]);

  /** Fixtures per type that will come in as chosen, not restored. */
  const counts = useMemo(() => {
    const restoredByType = new Map<string, number>();
    for (const uuid of restoredUuids) {
      const key = doc.typeOf.get(uuid);
      if (key) restoredByType.set(key, (restoredByType.get(key) ?? 0) + 1);
    }
    return restoredByType;
  }, [doc, restoredUuids]);

  const total = doc.types.reduce((sum, t) => sum + t.count, 0);
  const importing = doc.types.reduce((sum, t) => {
    const restored = counts.get(t.key) ?? 0;
    const choice = choices.get(t.key);
    return sum + restored + (choice && choice.kind !== 'skip' ? t.count - restored : 0);
  }, 0);

  const extent = planExtent(doc);
  const stage = project.stage;
  const overStage =
    extent !== undefined &&
    extent.max.x + offset.x > -stage.widthM / 2 &&
    extent.min.x + offset.x < stage.widthM / 2 &&
    extent.max.y + offset.y > -2 &&
    extent.min.y + offset.y < stage.depthM + 2;

  const setChoice = (key: string, choice: TypeChoice): void => {
    setChoices((prev) => new Map(prev).set(key, choice));
  };

  const runImport = (): void => {
    const rig = buildRig(doc, choices, models, { offset, restoreStagewash: restore });
    // A GDTF estimate imported twice replaces itself rather than piling up.
    const incoming = new Set(rig.customModels.map((m) => m.id));
    const next: Project = {
      ...project,
      name: rig.name ?? fileName.replace(/\.mvr$/i, ''),
      ...(rig.stage ? { stage: rig.stage } : {}),
      ...(rig.plane ? { plane: rig.plane } : {}),
      ...(rig.targets ? { targets: rig.targets } : {}),
      structures: rig.structures,
      fixtures: rig.fixtures,
      customModels: [...project.customModels.filter((m) => !incoming.has(m.id)), ...rig.customModels],
    };
    loadProject(next);
    onImported(rig.notes);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ width: 'min(860px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span>Import MVR — {fileName}</span>
          <span className="faint">
            {/* Provider is optional, and most files leave it out. */}
            {doc.scene.provider ? `${doc.scene.provider} · ` : ''}MVR {doc.scene.verMajor}.{doc.scene.verMinor}
          </span>
        </div>

        <div className="dialog-body">
          <div className="provenance-note">
            An MVR file places fixtures but carries <strong>no photometry</strong>. Tell stagewash what
            each fixture type is. A GDTF beam (a beam angle, a field angle and a flux) can stand in as
            an <span className="badge estimated">estimated</span> fixture when the file has real
            figures; for measured levels, choose or import the manufacturer’s IES file.
          </div>

          {doc.stagewash && (
            <Checkbox
              label={`This file came from stagewash: restore its fixture models, levels, gels, structures and stage (${restoredUuids.size} fixtures)`}
              checked={restore}
              onChange={setRestore}
            />
          )}

          {doc.types.length === 0 && <div className="warn-box">This file has no fixtures in it.</div>}

          {doc.types.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Type in the file</th>
                  <th style={{ width: 40, textAlign: 'right' }}>Qty</th>
                  <th style={{ width: '46%' }}>Calculate as</th>
                </tr>
              </thead>
              <tbody>
                {doc.types.map((type) => {
                  const restored = counts.get(type.key) ?? 0;
                  const beam = type.gdtf?.summary.beams[0];
                  const choice = choices.get(type.key) ?? { kind: 'skip' };
                  return (
                    <tr key={type.key}>
                      <td>
                        <div>{type.label}</div>
                        <div className="faint small">
                          {type.gdtf
                            ? (type.gdtfBeamProblem ??
                              `GDTF beam: ${beam?.beamAngle}° beam, ${beam?.fieldAngle}° field, ${beam?.luminousFlux.toLocaleString('en-GB')} lm`)
                            : type.gdtfSpec
                              ? 'Its GDTF is not in the file.'
                              : 'No GDTF named.'}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }} className="mono">
                        {type.count}
                      </td>
                      <td>
                        {restored === type.count ? (
                          <span className="faint small">Restored from stagewash data</span>
                        ) : (
                          <>
                            <select
                              value={encode(choice)}
                              onChange={(e) => setChoice(type.key, decode(e.target.value))}
                              style={{ width: '100%' }}
                            >
                              <option value="skip">— leave out —</option>
                              {type.gdtf && !type.gdtfBeamProblem && (
                                <option value="gdtf">Estimate from its GDTF beam</option>
                              )}
                              <ModelOptions models={allModels} />
                            </select>
                            {restored > 0 && (
                              <div className="faint small">
                                {restored} of {type.count} restored from stagewash data
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div>
            <div className="small" style={{ marginBottom: 6 }}>
              <strong>Placement.</strong>{' '}
              {extent ? (
                <>
                  The rig spans x {fmt(extent.min.x + offset.x)} to {fmt(extent.max.x + offset.x)} m and y{' '}
                  {fmt(extent.min.y + offset.y)} to {fmt(extent.max.y + offset.y)} m. The stage runs x{' '}
                  {fmt(-stage.widthM / 2)} to {fmt(stage.widthM / 2)} m, y 0 to {fmt(stage.depthM)} m from
                  its downstage edge.
                </>
              ) : (
                'Nothing to place.'
              )}
            </div>
            <div className="field-row-3">
              <NumberField label="Move x" suffix="m" value={offset.x} step={0.1} onChange={(x) => setOffset({ ...offset, x })} />
              <NumberField label="Move y" suffix="m" value={offset.y} step={0.1} onChange={(y) => setOffset({ ...offset, y })} />
              <NumberField label="Move z" suffix="m" value={offset.z} step={0.1} onChange={(z) => setOffset({ ...offset, z })} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
              <button onClick={() => setOffset(suggestOffset(doc, stage))} disabled={!extent}>
                {doc.scene.focusPoints.size > 0 ? 'Centre the focus points on the stage' : 'Centre the rig on the stage'}
              </button>
              <button onClick={() => setOffset({ x: 0, y: 0, z: 0 })}>As drawn</button>
            </div>
            {extent && !overStage && (
              <div className="warn-box" style={{ marginTop: 8 }}>
                The rig does not sit over the stage as placed, so the levels would be calculated
                somewhere it does not light. The drawing probably uses a different origin — try
                centring it.
              </div>
            )}
          </div>

          {doc.archive.gdtfErrors.size > 0 && (
            <div className="warn-box">
              {[...doc.archive.gdtfErrors].map(([file, reason]) => (
                <div key={file}>
                  Could not read {file}: {reason}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-foot" style={{ alignItems: 'center' }}>
          <span className="faint small" style={{ marginRight: 'auto' }}>
            {importing} of {total} {total === 1 ? 'fixture' : 'fixtures'} will be imported. This
            replaces the current rig; undo brings it back.
          </span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={runImport} disabled={importing === 0}>
            Import {importing}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelOptions({ models }: { models: FixtureModel[] }): React.ReactElement {
  return (
    <>
      {models.map((m) => (
        <optgroup key={m.id} label={`${m.manufacturer} ${m.name}`}>
          {m.optics.map((o) => (
            <option key={o.id} value={JSON.stringify([m.id, o.id])}>
              {m.manufacturer} {m.name}
              {m.optics.length > 1 ? ` — ${o.label}` : ''} ({o.photometrics.provenance})
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
