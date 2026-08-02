/**
 * Add fixtures: pick a model from the library, or build/import a custom one.
 *
 * The three tabs are the three provenance levels, in descending order of how
 * much you should trust them — and the dialog says so, because the whole point
 * of the provenance system is that the user sees it at the moment they choose.
 */

import { useMemo, useState } from 'react';

import { spacingAlong } from '../domain/rig';
import { estimatePhotometrics } from '../domain/photometry/estimator';
import { parseIes } from '../domain/photometry/ies';
import { parseLdt } from '../domain/photometry/ldt';
import { FIXTURE_LIBRARY, KIND_LABELS } from '../data/fixtures';
import { LAMP_INDEX } from '../data/lamps';
import type { FixtureKind, FixtureModel, RigFixture } from '../domain/types';
import { stageCentre, useStore } from '../state/store';
import { NumberField, ProvenanceBadge } from './Section';

type Tab = 'library' | 'import' | 'custom';

export function LibraryDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('library');

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span>Add fixtures</span>
          <div className="toolbar-group">
            <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
              Library
            </button>
            <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
              Import IES / LDT
            </button>
            <button className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>
              Custom
            </button>
          </div>
        </div>

        {tab === 'library' && <LibraryTab onClose={onClose} />}
        {tab === 'import' && <ImportTab onDone={() => setTab('library')} />}
        {tab === 'custom' && <CustomTab onDone={() => setTab('library')} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library tab
// ---------------------------------------------------------------------------

function LibraryTab({ onClose }: { onClose: () => void }): React.ReactElement {
  const project = useStore((s) => s.project);
  const addFixtures = useStore((s) => s.addFixtures);
  const selectedStructureId = useStore((s) => s.selectedStructureId);

  const all = useMemo(() => [...project.customModels, ...FIXTURE_LIBRARY], [project.customModels]);

  const [modelId, setModelId] = useState<string>(all[0]?.id ?? '');
  const [structureId, setStructureId] = useState<string>(
    selectedStructureId ?? project.structures[0]?.id ?? '',
  );
  const [count, setCount] = useState(4);
  const [inset, setInset] = useState(1.0);

  const model = all.find((m) => m.id === modelId);
  const structure = project.structures.find((s) => s.id === structureId);

  const add = (): void => {
    if (!model || !structure) return;
    const optic = model.optics[0];
    if (!optic) return;

    const positions = spacingAlong(structure, count, inset);
    const stamp = Date.now().toString(36);
    const aim = stageCentre(project);
    const highestChannel = project.fixtures.reduce((max, f) => {
      const n = Number.parseInt(f.channel, 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);

    const fixtures: RigFixture[] = positions.map((along, i) => ({
      id: `f-${stamp}-${i}`,
      channel: String(highestChannel + 1 + i),
      modelId: model.id,
      opticId: optic.id,
      structureId: structure.id,
      along,
      position: { x: 0, y: 0, z: 0 },
      focusMode: 'aim',
      // Fan the aims across the stage so a new bar is a usable starting wash
      // rather than every fixture piled on one spot.
      aim: {
        x: positions.length > 1 ? -project.stage.widthM / 3 + (i * ((project.stage.widthM * 2) / 3)) / (positions.length - 1) : aim.x,
        y: aim.y,
        z: project.stage.heightM,
      },
      pan: 0,
      tilt: -45,
      roll: 0,
      level: 1,
      transmission: 1,
      enabled: true,
    }));

    addFixtures(fixtures);
    onClose();
  };

  return (
    <>
      <div className="dialog-body">
        <div className="field-row">
          <div>
            <label>Hang on</label>
            <select value={structureId} onChange={(e) => setStructureId(e.target.value)}>
              {project.structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <NumberField label="How many" value={count} step={1} min={1} max={48} onChange={(v) => setCount(Math.round(v))} />
            <NumberField label="End inset" suffix="m" value={inset} step={0.1} min={0} onChange={setInset} />
          </div>
        </div>

        <div style={{ display: 'grid', gap: 5 }}>
          {all.map((m) => (
            <div
              key={m.id}
              className={`library-item ${m.id === modelId ? 'selected' : ''}`}
              onClick={() => setModelId(m.id)}
            >
              <div>
                <div>
                  {m.manufacturer} {m.name}
                </div>
                <div className="faint small">
                  {KIND_LABELS[m.kind]} · {m.watts} W · {m.weightKg} kg
                  {m.lampId ? ` · ${LAMP_INDEX.get(m.lampId)?.name ?? m.lampId}` : ''}
                  {m.optics.length > 1 ? ` · ${m.optics.length} optics` : ''}
                </div>
              </div>
              <ProvenanceBadge provenance={m.optics[0]?.photometrics.provenance ?? 'estimated'} />
            </div>
          ))}
        </div>

        <div className="provenance-note">
          <strong>measured</strong> comes from a manufacturer photometric file.{' '}
          <strong>published</strong> means the beam angle, field angle and centre-beam candela are
          transcribed from a named datasheet and only the roll-off between them is modelled.{' '}
          <strong>estimated</strong> is a generic archetype, not a real product — useful for
          blocking out a rig, not for promising a level.
        </div>
      </div>

      <div className="dialog-foot">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={add} disabled={!model || !structure}>
          Add {count}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Import tab
// ---------------------------------------------------------------------------

function ImportTab({ onDone }: { onDone: () => void }): React.ReactElement {
  const addCustomModel = useStore((s) => s.addCustomModel);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [imported, setImported] = useState<string | null>(null);

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setError(null);
    setWarnings([]);
    setImported(null);

    const results: string[] = [];
    const allWarnings: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const isLdt = /\.ldt$/i.test(file.name);
        const parsed = isLdt ? parseLdt(text) : parseIes(text);

        const name = isLdt
          ? (parsed as ReturnType<typeof parseLdt>).luminaireName || file.name
          : ((parsed as ReturnType<typeof parseIes>).keywords['LUMCAT'] ??
            (parsed as ReturnType<typeof parseIes>).keywords['LUMINAIRE'] ??
            file.name);
        const manufacturer = isLdt
          ? (parsed as ReturnType<typeof parseLdt>).company || 'Imported'
          : ((parsed as ReturnType<typeof parseIes>).keywords['MANUFAC'] ?? 'Imported');

        const model: FixtureModel = {
          id: `custom-${Date.now().toString(36)}-${results.length}`,
          manufacturer: manufacturer.slice(0, 60),
          name: String(name).slice(0, 80),
          // A photometric file says nothing about what kind of fixture it is,
          // and guessing from the beam angle would be a guess. `profile` only
          // affects which defaults the UI offers, never the maths, because the
          // distribution is measured.
          kind: 'profile',
          watts: Math.round(parsed.watts) || 0,
          weightKg: 0,
          optics: [
            {
              id: 'measured',
              label: 'As measured',
              photometrics: parsed.photometrics,
            },
          ],
          notes: `Imported from ${file.name}.`,
        };

        addCustomModel(model);
        results.push(`${model.manufacturer} ${model.name}`);
        allWarnings.push(...parsed.warnings.map((w) => `${file.name}: ${w}`));
      } catch (cause) {
        setError(
          `${file.name}\n${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return;
      }
    }

    setWarnings(allWarnings);
    setImported(results.join(', '));
  };

  return (
    <>
      <div className="dialog-body">
        <div className="provenance-note">
          Import a manufacturer photometric file — <strong>.ies</strong> (IESNA LM-63) or{' '}
          <strong>.ldt</strong> (EULUMDAT). This is the only way to get{' '}
          <span className="badge measured">measured</span> data into the model, and it is what to
          do whenever the answer actually has to be right. Most manufacturers publish these on the
          product page.
        </div>

        <div>
          <label>Photometric file</label>
          <input
            type="file"
            accept=".ies,.IES,.ldt,.LDT,text/plain"
            multiple
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </div>

        {error && <div className="err-box">{error}</div>}

        {imported && (
          <div className="provenance-note">
            Imported <strong>{imported}</strong>. It is now at the top of the Library tab.
          </div>
        )}

        {warnings.length > 0 && (
          <div className="warn-box">
            {warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        <div className="faint small">
          Type A and Type B photometrics are rejected rather than read as Type C — their angles are
          measured from different axes, and reading one as the other gives a wrong answer that
          looks right.
        </div>
      </div>

      <div className="dialog-foot">
        <button className="primary" onClick={onDone} disabled={!imported}>
          Done
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Custom tab
// ---------------------------------------------------------------------------

const KIND_LIST = Object.keys(KIND_LABELS) as FixtureKind[];

function CustomTab({ onDone }: { onDone: () => void }): React.ReactElement {
  const addCustomModel = useStore((s) => s.addCustomModel);

  const [name, setName] = useState('My fixture');
  const [kind, setKind] = useState<FixtureKind>('profile');
  const [fieldAngle, setFieldAngle] = useState(26);
  const [beamAngle, setBeamAngle] = useState(19);
  const [useBeamAngle, setUseBeamAngle] = useState(false);
  const [watts, setWatts] = useState(750);
  const [weightKg, setWeightKg] = useState(7);

  type Basis = 'lamp' | 'output' | 'candela' | 'lux';
  const [basis, setBasis] = useState<Basis>('lamp');
  const [lumens, setLumens] = useState(21_900);
  const [candela, setCandela] = useState(90_000);
  const [lux, setLux] = useState(1000);
  const [distance, setDistance] = useState(10);

  const preview = useMemo(() => {
    try {
      return estimatePhotometrics({
        kind,
        fieldAngle,
        ...(useBeamAngle ? { beamAngle } : {}),
        ...(basis === 'lamp' ? { lumens } : {}),
        ...(basis === 'output' ? { lumens, lumensAtLens: true } : {}),
        ...(basis === 'candela' ? { peakCandela: candela } : {}),
        ...(basis === 'lux' ? { luxAtDistance: { lux, distanceM: distance } } : {}),
      });
    } catch {
      return null;
    }
  }, [kind, fieldAngle, beamAngle, useBeamAngle, basis, lumens, candela, lux, distance]);

  const create = (): void => {
    if (!preview) return;
    addCustomModel({
      id: `custom-${Date.now().toString(36)}`,
      manufacturer: 'Custom',
      name,
      kind,
      watts,
      weightKg,
      optics: [{ id: 'main', label: `${fieldAngle}° field`, photometrics: preview }],
    });
    onDone();
  };

  return (
    <>
      <div className="dialog-body">
        <div className="field-row">
          <div>
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label>Type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as FixtureKind)}>
              {KIND_LIST.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field-row">
          <NumberField label="Field angle (10% of peak)" suffix="°" value={fieldAngle} step={1} min={1} onChange={setFieldAngle} />
          <div>
            <label>
              <input
                type="checkbox"
                checked={useBeamAngle}
                onChange={(e) => setUseBeamAngle(e.target.checked)}
              />{' '}
              Beam angle (50%)
            </label>
            <input
              type="number"
              value={beamAngle}
              disabled={!useBeamAngle}
              onChange={(e) => setBeamAngle(Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <label>Scale the output from</label>
          <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
            <option value="candela">Centre-beam candela — best, assumes nothing</option>
            <option value="lux">Lux at a distance — same thing, as datasheets print it</option>
            <option value="output">Fixture output lumens (LED, at the lens)</option>
            <option value="lamp">Bare lamp lumens — weakest, assumes an efficiency</option>
          </select>
        </div>

        {basis === 'candela' && (
          <NumberField label="Centre-beam candela" suffix="cd" value={candela} step={1000} onChange={setCandela} />
        )}
        {basis === 'lux' && (
          <div className="field-row">
            <NumberField label="Illuminance" suffix="lux" value={lux} step={50} onChange={setLux} />
            <NumberField label="At distance" suffix="m" value={distance} step={0.5} min={0.1} onChange={setDistance} />
          </div>
        )}
        {(basis === 'lamp' || basis === 'output') && (
          <NumberField label="Lumens" suffix="lm" value={lumens} step={500} onChange={setLumens} />
        )}

        <div className="field-row">
          <NumberField label="Watts" value={watts} step={25} onChange={setWatts} />
          <NumberField label="Weight" suffix="kg" value={weightKg} step={0.5} onChange={setWeightKg} />
        </div>

        {preview && (
          <div className="provenance-note">
            <ProvenanceBadge provenance="estimated" />
            <div className="mono" style={{ marginTop: 4 }}>
              {Math.round(preview.peakCandela).toLocaleString()} cd centre beam ·{' '}
              {preview.beamAngle.toFixed(1)}° beam · {preview.fieldAngle.toFixed(1)}° field ·{' '}
              {Math.round(preview.outputLumens).toLocaleString()} lm total
            </div>
            <div style={{ marginTop: 4 }}>{preview.source}</div>
            {basis === 'lamp' && (
              <div style={{ marginTop: 4 }}>
                Estimating from bare-lamp lumens lands within about 25% of a real fixture, because
                optical efficiency varies from 42% to 65% across fixtures of the same class. If you
                have the manufacturer's IES file, import that instead.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="dialog-foot">
        <button className="primary" onClick={create} disabled={!preview}>
          Create fixture
        </button>
      </div>
    </>
  );
}
