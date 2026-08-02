/**
 * The fixture library.
 *
 * ## The rule
 *
 * **No candela figure in this file is invented.** Every entry is one of:
 *
 * - `published` — beam angle, field angle and centre-beam candela transcribed
 *   from a named manufacturer datasheet. The *shape* between those anchors is
 *   still the estimator's super-Gaussian, but the three numbers that set the
 *   scale and the width are the manufacturer's own. These are as good as this
 *   tool gets without importing the manufacturer's IES file.
 * - `estimated` — an **archetype**, not a real product: "1 kW fresnel",
 *   "LED wash". Named generically on purpose, so nobody reads it as a claim
 *   about a specific fixture. Scaled from nominal lamp output through the
 *   calibrated optical efficiency in `estimator.ts`.
 *
 * There is deliberately no third category of "real product, guessed numbers".
 * A library full of plausible-looking entries for fixtures nobody measured is
 * worse than a small honest one, because the provenance badge is the only thing
 * standing between a user and a confident wrong answer.
 *
 * To get `measured` data, import the manufacturer's IES file — every fixture
 * here that ETC publishes photometry for has one on their website, and the
 * import path exists precisely so this file does not have to grow.
 *
 * ## Adding an entry
 *
 * Published: take centre-beam candela, beam angle and field angle off the
 * datasheet, cite it in `source`, set `provenance: 'published'`. Do not compute
 * candela from lumens — if the datasheet gives candela, use candela.
 */

import { estimatePhotometrics } from '../domain/photometry/estimator';
import type { FixtureModel, FixtureOptic, FixtureKind } from '../domain/types';

/** Build an optic from a datasheet's published beam/field/candela triple. */
function publishedOptic(options: {
  id: string;
  label: string;
  kind: FixtureKind;
  beamAngle: number;
  fieldAngle: number;
  /** Cross-axis angles for a fixture with an oval beam. */
  beamAngleCross?: number;
  fieldAngleCross?: number;
  peakCandela: number;
  source: string;
  zoomMin?: number;
  zoomMax?: number;
}): FixtureOptic {
  const photometrics = estimatePhotometrics({
    kind: options.kind,
    beamAngle: options.beamAngle,
    fieldAngle: options.fieldAngle,
    ...(options.beamAngleCross !== undefined ? { beamAngleCross: options.beamAngleCross } : {}),
    ...(options.fieldAngleCross !== undefined ? { fieldAngleCross: options.fieldAngleCross } : {}),
    peakCandela: options.peakCandela,
  });

  return {
    id: options.id,
    label: options.label,
    photometrics: {
      ...photometrics,
      // The scale and the width are the manufacturer's; only the roll-off
      // between the anchors is modelled.
      provenance: 'published',
      source: options.source,
    },
    ...(options.zoomMin !== undefined ? { zoomMin: options.zoomMin } : {}),
    ...(options.zoomMax !== undefined ? { zoomMax: options.zoomMax } : {}),
  };
}

/** Build an optic for a generic archetype from nominal lamp output. */
function archetypeOptic(options: {
  id: string;
  label: string;
  kind: FixtureKind;
  fieldAngle: number;
  beamAngle?: number;
  fieldAngleCross?: number;
  lumens: number;
  lumensAtLens?: boolean;
  note: string;
  zoomMin?: number;
  zoomMax?: number;
}): FixtureOptic {
  const photometrics = estimatePhotometrics({
    kind: options.kind,
    fieldAngle: options.fieldAngle,
    ...(options.beamAngle !== undefined ? { beamAngle: options.beamAngle } : {}),
    ...(options.fieldAngleCross !== undefined ? { fieldAngleCross: options.fieldAngleCross } : {}),
    lumens: options.lumens,
    // An LED fixture's published output is an integrating-sphere total; a
    // tungsten fixture's datasheet quotes field lumens. Same word, different
    // quantity, about 10% apart. `lumensAtLens` is exactly the LED case, and
    // the estimator picks the right basis from it.
    ...(options.lumensAtLens ? { lumensAtLens: true } : {}),
  });

  return {
    id: options.id,
    label: options.label,
    photometrics: { ...photometrics, source: `${options.note} ${photometrics.source}` },
    ...(options.zoomMin !== undefined ? { zoomMin: options.zoomMin } : {}),
    ...(options.zoomMax !== undefined ? { zoomMax: options.zoomMax } : {}),
  };
}

const S4_36 = 'ETC Source Four 36° Ellipsoidal datasheet, photometrics table (HPL 750 W/115 V).';
const S4_JR = 'ETC Source Four jr 26° Ellipsoidal datasheet, photometrics table (HPL 575 W/115 V).';
const S4_ZOOM = 'ETC Source Four Zoom 15°–30° datasheet, photometrics table (HPL 750 W/115 V).';
const S4_PARNEL = 'ETC Source Four PARNel datasheet, photometrics table (HPL 750 W/115 V).';
// Note the lamp: the PAR MCM datasheet measures its photometrics with an
// HPL 575, while the 36°, Zoom and PARNel sheets use an HPL 750. Reading the
// whole Source Four range as 750 W puts this fixture's efficiency at 36%
// instead of the 47% ETC quote, which is what `calibration.test.ts` caught.
const S4_PAR_MCM = 'ETC Source Four PAR MCM datasheet, photometrics table (HPL 575 W/115 V).';

export const FIXTURE_LIBRARY: FixtureModel[] = [
  // -------------------------------------------------------------------------
  // Profiles / ellipsoidals — published
  // -------------------------------------------------------------------------
  {
    id: 'etc-s4-36',
    manufacturer: 'ETC',
    name: 'Source Four 36°',
    kind: 'profile',
    lampId: 'hpl-750-115',
    watts: 750,
    weightKg: 7.3,
    optics: [
      publishedOptic({
        id: '36',
        label: '36° lens tube',
        kind: 'profile',
        beamAngle: 27,
        fieldAngle: 34,
        peakCandela: 90_885,
        source: S4_36,
      }),
    ],
    notes:
      'Nominal 36°; the datasheet measures a 34° field and a 27° beam. 14,240 field lumens, 65% efficiency.',
  },
  {
    id: 'etc-s4-jr-26',
    manufacturer: 'ETC',
    name: 'Source Four jr 26°',
    kind: 'profile',
    lampId: 'hpl-575-115',
    watts: 575,
    weightKg: 5.4,
    optics: [
      publishedOptic({
        id: '26',
        label: '26° lens tube',
        kind: 'profile',
        beamAngle: 20,
        fieldAngle: 25,
        peakCandela: 91_480,
        source: S4_JR,
      }),
    ],
    notes: 'Nominal 26°; measured 25° field, 20° beam. 7,795 field lumens, 47.2% efficiency.',
  },
  {
    id: 'etc-s4-zoom-15-30',
    manufacturer: 'ETC',
    name: 'Source Four Zoom 15°–30°',
    kind: 'profile',
    lampId: 'hpl-750-115',
    watts: 750,
    weightKg: 9.1,
    optics: [
      // Three measured zoom positions rather than one stretched distribution.
      // A measured photometric describes the position it was measured at, and
      // `resolvePhotometry` will not stretch one — this is why.
      publishedOptic({
        id: 'z15',
        label: '15° (full spot)',
        kind: 'profile',
        beamAngle: 11,
        fieldAngle: 16,
        peakCandela: 395_560,
        source: S4_ZOOM,
      }),
      publishedOptic({
        id: 'z23',
        label: '23° (mid)',
        kind: 'profile',
        beamAngle: 16,
        fieldAngle: 23,
        peakCandela: 181_685,
        source: S4_ZOOM,
      }),
      publishedOptic({
        id: 'z30',
        label: '30° (full flood)',
        kind: 'profile',
        beamAngle: 21,
        fieldAngle: 31,
        peakCandela: 105_690,
        source: S4_ZOOM,
      }),
    ],
    notes:
      'Three measured zoom positions. Field lumens stay near 12,000 across the range, which is the flux-conservation model this app uses for zoom, confirmed on a real fixture.',
  },

  // -------------------------------------------------------------------------
  // PAR / PARNel — published
  // -------------------------------------------------------------------------
  {
    id: 'etc-s4-parnel',
    manufacturer: 'ETC',
    name: 'Source Four PARNel',
    kind: 'fresnel',
    lampId: 'hpl-750-115',
    watts: 750,
    weightKg: 6.4,
    optics: [
      publishedOptic({
        id: 'spot',
        label: 'Spot',
        kind: 'fresnel',
        beamAngle: 12,
        fieldAngle: 24,
        peakCandela: 190_390,
        source: S4_PARNEL,
        zoomMin: 24,
        zoomMax: 47,
      }),
      publishedOptic({
        id: 'flood',
        label: 'Flood',
        kind: 'fresnel',
        beamAngle: 29,
        fieldAngle: 47,
        peakCandela: 47_050,
        source: S4_PARNEL,
        zoomMin: 24,
        zoomMax: 47,
      }),
    ],
    notes: 'Rotatable oval-to-round wash. Spot 41.7% efficiency, flood 48.2%.',
  },
  {
    id: 'etc-s4-par-mcm',
    manufacturer: 'ETC',
    name: 'Source Four PAR MCM',
    kind: 'par',
    lampId: 'hpl-575-115',
    watts: 575,
    weightKg: 5.9,
    optics: [
      publishedOptic({
        id: 'vnsp',
        label: 'VNSP',
        kind: 'par',
        beamAngle: 8,
        fieldAngle: 16,
        peakCandela: 343_440,
        source: S4_PAR_MCM,
      }),
      publishedOptic({
        id: 'nsp',
        label: 'NSP',
        kind: 'par',
        beamAngle: 9,
        fieldAngle: 16,
        peakCandela: 297_851,
        source: S4_PAR_MCM,
      }),
      // The MFL and WFL lenses throw a genuinely oval beam, and the datasheet
      // quotes both axes. This is the library's worked example of an
      // asymmetric distribution.
      publishedOptic({
        id: 'mfl',
        label: 'MFL (oval)',
        kind: 'par',
        beamAngle: 19,
        fieldAngle: 31,
        beamAngleCross: 13,
        fieldAngleCross: 23,
        peakCandela: 104_708,
        source: S4_PAR_MCM,
      }),
      publishedOptic({
        id: 'wfl',
        label: 'WFL (oval)',
        kind: 'par',
        beamAngle: 32,
        fieldAngle: 52,
        beamAngleCross: 20,
        fieldAngleCross: 37,
        peakCandela: 34_656,
        source: S4_PAR_MCM,
      }),
    ],
    notes:
      'MFL and WFL are oval: the wide axis is C0 (set the fixture roll to orient it). Datasheet quotes 19°H/13°V beam and 31°H/23°V field for MFL.',
  },

  // -------------------------------------------------------------------------
  // Archetypes — estimated. Generic names on purpose.
  // -------------------------------------------------------------------------
  {
    id: 'generic-fresnel-1k',
    manufacturer: 'Generic',
    name: '1 kW Fresnel',
    kind: 'fresnel',
    lampId: 'generic-t19-1000',
    watts: 1000,
    weightKg: 6.5,
    optics: [
      archetypeOptic({
        id: 'spot',
        label: 'Spot',
        kind: 'fresnel',
        fieldAngle: 14,
        lumens: 26_000,
        note: 'Archetype, not a specific product.',
        zoomMin: 14,
        zoomMax: 60,
      }),
      archetypeOptic({
        id: 'flood',
        label: 'Flood',
        kind: 'fresnel',
        fieldAngle: 60,
        lumens: 26_000,
        note: 'Archetype, not a specific product.',
        zoomMin: 14,
        zoomMax: 60,
      }),
    ],
    notes: 'Generic 1 kW fresnel with a nominal 14°–60° spot-to-flood range.',
  },
  {
    id: 'generic-fresnel-2k',
    manufacturer: 'Generic',
    name: '2 kW Fresnel',
    kind: 'fresnel',
    lampId: 'generic-t11-2000',
    watts: 2000,
    weightKg: 11,
    optics: [
      archetypeOptic({
        id: 'spot',
        label: 'Spot',
        kind: 'fresnel',
        fieldAngle: 12,
        lumens: 55_000,
        note: 'Archetype, not a specific product.',
        zoomMin: 12,
        zoomMax: 55,
      }),
      archetypeOptic({
        id: 'flood',
        label: 'Flood',
        kind: 'fresnel',
        fieldAngle: 55,
        lumens: 55_000,
        note: 'Archetype, not a specific product.',
        zoomMin: 12,
        zoomMax: 55,
      }),
    ],
  },
  {
    id: 'generic-par64-cp62',
    manufacturer: 'Generic',
    name: 'PAR64 1 kW (MFL)',
    kind: 'par',
    lampId: 'generic-cp62-1000',
    watts: 1000,
    weightKg: 3.2,
    optics: [
      archetypeOptic({
        id: 'mfl',
        label: 'CP62 medium flood (oval)',
        kind: 'par',
        fieldAngle: 21,
        fieldAngleCross: 11,
        lumens: 25_000,
        note: 'Archetype, not a specific product.',
      }),
    ],
    notes: 'Sealed-beam PAR64. The beam is strongly oval — rotate the lamp to orient it.',
  },
  {
    id: 'generic-led-wash-200',
    manufacturer: 'Generic',
    name: 'LED Wash 200 W',
    kind: 'wash',
    watts: 200,
    weightKg: 4.5,
    colourMixing: true,
    optics: [
      archetypeOptic({
        id: 'zoom',
        label: 'Zoom 15°–60°',
        kind: 'wash',
        fieldAngle: 25,
        lumens: 7500,
        lumensAtLens: true,
        note: 'Archetype, not a specific product.',
        zoomMin: 15,
        zoomMax: 60,
      }),
    ],
    notes:
      'Output is quoted at full white. Colour mixing costs output — a saturated colour can be a fifth of this, and the app does not model that. Set the transmission on the fixture to account for it.',
  },
  {
    id: 'generic-led-cyc',
    manufacturer: 'Generic',
    name: 'LED Cyc Light',
    kind: 'cyc',
    watts: 150,
    weightKg: 5,
    colourMixing: true,
    optics: [
      archetypeOptic({
        id: 'asym',
        label: 'Asymmetric',
        kind: 'cyc',
        // A cyc unit throws a wide, tall, deliberately uneven wash. The
        // archetype models the wide/narrow axes only; a real cyc unit's
        // asymmetric *vertical* throw is what evens out a cloth top to bottom,
        // and that is not captured by a symmetric roll-off. Import the real
        // IES if the evenness of the cloth is what you are checking.
        fieldAngle: 100,
        fieldAngleCross: 55,
        lumens: 6000,
        lumensAtLens: true,
        note: 'Archetype, not a specific product.',
      }),
    ],
    notes:
      'Wide asymmetric wash for a cyc or backdrop. The archetype does NOT model the vertical asymmetry that makes a real cyc unit even top-to-bottom — import the manufacturer IES if that is what you are checking.',
  },
  {
    id: 'generic-led-batten',
    manufacturer: 'Generic',
    name: 'LED Batten 1 m',
    kind: 'batten',
    watts: 100,
    weightKg: 3.5,
    colourMixing: true,
    optics: [
      archetypeOptic({
        id: 'wide',
        label: 'Wide',
        kind: 'batten',
        fieldAngle: 110,
        fieldAngleCross: 30,
        lumens: 4000,
        lumensAtLens: true,
        note: 'Archetype, not a specific product.',
      }),
    ],
    notes:
      'Modelled as a point source at the centre of the batten. That overstates levels closer than about twice its length — a 1 m batten is not a point at 0.5 m.',
  },
  {
    id: 'generic-moving-spot-350',
    manufacturer: 'Generic',
    name: 'Moving Spot 350 W',
    kind: 'movingSpot',
    watts: 350,
    weightKg: 21,
    panRange: 540,
    tiltRange: 265,
    optics: [
      archetypeOptic({
        id: 'zoom',
        label: 'Zoom 8°–40°',
        kind: 'movingSpot',
        fieldAngle: 20,
        lumens: 15_000,
        lumensAtLens: true,
        note: 'Archetype, not a specific product.',
        zoomMin: 8,
        zoomMax: 40,
      }),
    ],
  },
  {
    id: 'generic-moving-wash-350',
    manufacturer: 'Generic',
    name: 'Moving Wash 350 W',
    kind: 'movingWash',
    watts: 350,
    weightKg: 19,
    panRange: 540,
    tiltRange: 265,
    colourMixing: true,
    optics: [
      archetypeOptic({
        id: 'zoom',
        label: 'Zoom 12°–50°',
        kind: 'movingWash',
        fieldAngle: 30,
        lumens: 13_000,
        lumensAtLens: true,
        note: 'Archetype, not a specific product.',
        zoomMin: 12,
        zoomMax: 50,
      }),
    ],
  },
];

export const FIXTURE_INDEX: ReadonlyMap<string, FixtureModel> = new Map(
  FIXTURE_LIBRARY.map((model) => [model.id, model]),
);

/** Grouping for the library browser. */
export const KIND_LABELS: Record<FixtureKind, string> = {
  profile: 'Profile / ellipsoidal',
  fresnel: 'Fresnel',
  pc: 'PC / plano-convex',
  par: 'PAR',
  wash: 'LED wash',
  cyc: 'Cyc / groundrow',
  batten: 'Batten',
  movingSpot: 'Moving spot',
  movingWash: 'Moving wash',
  beam: 'Beam',
};
