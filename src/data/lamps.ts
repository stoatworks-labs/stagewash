/**
 * Lamp table.
 *
 * Every entry is transcribed from a manufacturer datasheet's lamp table, with
 * the datasheet named in `source`. Nothing here is inferred: initial lumens,
 * colour temperature and rated life are read straight off the page.
 *
 * These matter because the estimator scales a synthesised distribution by lamp
 * output, and because swapping a 750 W lamp for a 575 W one in the same fixture
 * is a real and common decision that changes the answer by a third.
 */

import type { LampSpec } from '../domain/types';

const ETC_S4_DATASHEET =
  'ETC Source Four 36° Ellipsoidal datasheet, Lamps table (also carried identically on the Source Four Zoom, jr and PARNel datasheets)';

export const LAMPS: LampSpec[] = [
  {
    id: 'hpl-750-115',
    name: 'HPL 750 W / 115 V',
    lumens: 21_900,
    watts: 750,
    cct: 3250,
    provenance: 'published',
    source: ETC_S4_DATASHEET,
  },
  {
    id: 'hpl-750-115x',
    name: 'HPL 750 W / 115 V X (long life)',
    lumens: 16_400,
    watts: 750,
    cct: 3050,
    provenance: 'published',
    source: ETC_S4_DATASHEET,
  },
  {
    id: 'hpl-575-115',
    name: 'HPL 575 W / 115 V',
    lumens: 16_520,
    watts: 575,
    cct: 3250,
    provenance: 'published',
    source: ETC_S4_DATASHEET,
  },
  {
    id: 'hpl-575-115x',
    name: 'HPL 575 W / 115 V X (long life)',
    lumens: 12_360,
    watts: 575,
    cct: 3050,
    provenance: 'published',
    source: ETC_S4_DATASHEET,
  },
  {
    id: 'hpl-375-115',
    name: 'HPL 375 W / 115 V',
    lumens: 10_540,
    watts: 375,
    cct: 3250,
    provenance: 'published',
    source: ETC_S4_DATASHEET,
  },
  // ------------------------------------------------------------------
  // Generic tungsten lamps for the archetype fixtures. Nominal catalogue
  // figures for the lamp class rather than a specific part, and marked as
  // estimates because they are not read off one datasheet.
  // ------------------------------------------------------------------
  {
    id: 'generic-t19-1000',
    name: 'Generic 1 kW tungsten halogen (T19 / CP class)',
    lumens: 26_000,
    watts: 1000,
    cct: 3200,
    provenance: 'estimated',
    source: 'Nominal for a 1 kW 3200 K studio halogen lamp; not a specific part number.',
  },
  {
    id: 'generic-t11-2000',
    name: 'Generic 2 kW tungsten halogen',
    lumens: 55_000,
    watts: 2000,
    cct: 3200,
    provenance: 'estimated',
    source: 'Nominal for a 2 kW 3200 K studio halogen lamp; not a specific part number.',
  },
  {
    id: 'generic-cp62-1000',
    name: 'Generic PAR64 1 kW (CP62 medium class)',
    lumens: 25_000,
    watts: 1000,
    cct: 3200,
    provenance: 'estimated',
    source: 'Nominal for a 1 kW PAR64 sealed beam; not a specific part number.',
  },
];

export const LAMP_INDEX: ReadonlyMap<string, LampSpec> = new Map(
  LAMPS.map((lamp) => [lamp.id, lamp]),
);
