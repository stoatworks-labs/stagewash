/**
 * The few things stagewash reads out of a GDTF fixture type.
 *
 * GDTF is a full device description — DMX modes, wheels, emitters, 3D models
 * — and almost none of it bears on illuminance. What does is the `<Beam>`
 * geometry: a beam angle, a field angle and a luminous flux. That is enough to
 * fit stagewash's analytic shape, and nowhere near enough to call the result
 * photometry. It is an estimate and is badged as one.
 *
 * Two things about real GDTF files decide how far to trust even that:
 *
 * - **Many carry the format's default beam.** The spec defaults are 25° beam,
 *   25° field, 10,000 lm, 1000 W, and a file written by a tool that never asked
 *   for real figures carries exactly those. Vectorworks' generic "Light Source
 *   Pendant 44deg" does: a fixture named 44° whose file says 25°. A beam angle
 *   equal to its field angle is physically impossible, so that combination is
 *   flagged as a placeholder rather than read as data.
 * - **Some have no beam at all.** Capture writes stub GDTFs — DMX modes only,
 *   one `Base` geometry, no `<Beam>`. Such a file names the fixture and says
 *   nothing about its light.
 */

import { child, descendants, parseXml, type XmlElement } from './xml';

/** The GDTF spec's defaults for a `<Beam>` attribute that is absent. */
export const GDTF_BEAM_DEFAULTS = {
  beamAngle: 25,
  fieldAngle: 25,
  luminousFlux: 10000,
  powerConsumption: 1000,
  lampType: 'Discharge',
  beamType: 'Wash',
} as const;

export interface GdtfBeam {
  name: string;
  beamAngle: number;
  fieldAngle: number;
  /** "Intensity of all the represented light emitters", lumens. */
  luminousFlux: number;
  powerConsumption: number;
  lampType: string;
  beamType: string;
  /**
   * True when beam, field and flux are all exactly the spec defaults — which
   * means the file's author never entered them.
   */
  placeholder: boolean;
}

export interface GdtfSummary {
  manufacturer: string;
  name: string;
  beams: GdtfBeam[];
  /** True when the geometry tree instances parts by reference, so beams may repeat. */
  hasGeometryReferences: boolean;
  /** Weight of the device, kilograms, when the file states a non-zero one. */
  weightKg?: number;
  /** True when a DMX mode drives Pan or Tilt. */
  hasPanTilt: boolean;
}

export class GdtfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GdtfParseError';
  }
}

const num = (el: XmlElement, attr: string, fallback: number): number => {
  const raw = el.attrs[attr];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
};

/** Read a GDTF `description.xml`. */
export function parseGdtfDescription(xml: string): GdtfSummary {
  const root = parseXml(xml);
  const fixtureType = root.name === 'FixtureType' ? root : child(root, 'FixtureType');
  if (!fixtureType) throw new GdtfParseError('description.xml has no <FixtureType>.');

  const geometries = child(fixtureType, 'Geometries');
  const beams = geometries
    ? descendants(geometries, 'Beam').map((b): GdtfBeam => {
        const beamAngle = num(b, 'BeamAngle', GDTF_BEAM_DEFAULTS.beamAngle);
        const fieldAngle = num(b, 'FieldAngle', GDTF_BEAM_DEFAULTS.fieldAngle);
        const luminousFlux = num(b, 'LuminousFlux', GDTF_BEAM_DEFAULTS.luminousFlux);
        return {
          name: b.attrs.Name ?? '',
          beamAngle,
          fieldAngle,
          luminousFlux,
          powerConsumption: num(b, 'PowerConsumption', GDTF_BEAM_DEFAULTS.powerConsumption),
          lampType: b.attrs.LampType ?? GDTF_BEAM_DEFAULTS.lampType,
          beamType: b.attrs.BeamType ?? GDTF_BEAM_DEFAULTS.beamType,
          placeholder:
            beamAngle === GDTF_BEAM_DEFAULTS.beamAngle &&
            fieldAngle === GDTF_BEAM_DEFAULTS.fieldAngle &&
            luminousFlux === GDTF_BEAM_DEFAULTS.luminousFlux,
        };
      })
    : [];

  const weight = descendants(fixtureType, 'Weight')[0];
  const weightKg = weight ? num(weight, 'Value', 0) : 0;

  const modes = child(fixtureType, 'DMXModes');
  const hasPanTilt = modes
    ? descendants(modes, 'LogicalChannel').some((lc) =>
        /^(Pan|Tilt)(Rotate)?$/.test(lc.attrs.Attribute ?? ''),
      )
    : false;

  return {
    manufacturer: fixtureType.attrs.Manufacturer ?? '',
    name: fixtureType.attrs.Name ?? fixtureType.attrs.LongName ?? '',
    beams,
    hasGeometryReferences: geometries ? descendants(geometries, 'GeometryReference').length > 0 : false,
    ...(weightKg > 0 ? { weightKg } : {}),
    hasPanTilt,
  };
}
