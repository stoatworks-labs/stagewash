/**
 * The PDF report. Imported dynamically — see the note in `common.ts`.
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

import { panTiltToAim, runLength } from '../domain/geometry';
import { formatLevel, unitLabel, type Unit } from '../domain/metrics';
import { findOptic, modelIndex } from '../domain/rig';
import { FIXTURE_LIBRARY } from '../data/fixtures';
import type { Metrics } from '../domain/types';
import { MODEL_CAVEAT, type ReportInput } from './common';

function levelsFor(metrics: Metrics, unit: Unit): Array<[string, string]> {
  const u = unitLabel(unit);
  return [
    ['Average', `${formatLevel(metrics.avg, unit)} ${u}`],
    ['Minimum', `${formatLevel(metrics.min, unit)} ${u}`],
    ['Maximum', `${formatLevel(metrics.max, unit)} ${u}`],
    ['Median', `${formatLevel(metrics.median, unit)} ${u}`],
    ['Uniformity min:avg', metrics.uniformityMinAvg.toFixed(2)],
    ['Uniformity min:max', metrics.uniformityMinMax.toFixed(2)],
    ['Coverage at target', `${(metrics.coverage * 100).toFixed(1)} %`],
    ['Below dark threshold', `${(metrics.darkFraction * 100).toFixed(1)} %`],
    ['Above hot threshold', `${(metrics.hotFraction * 100).toFixed(1)} %`],
  ];
}

export function buildPdf(input: ReportInput): jsPDF {
  const { project, metrics, blobs, perFixtureAvg, issues, unit } = input;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const models = modelIndex(FIXTURE_LIBRARY, project.customModels);
  const u = unitLabel(unit);

  doc.setFontSize(16);
  doc.text('stagewash — coverage report', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(project.name, 14, 25);
  doc.text(new Date().toLocaleString(), 196, 25, { align: 'right' });
  doc.setTextColor(0);

  // --- setup ---------------------------------------------------------------
  autoTable(doc, {
    startY: 32,
    head: [['Setup', '']],
    body: [
      ['Stage', `${project.stage.widthM} × ${project.stage.depthM} m, deck at ${project.stage.heightM} m`],
      [
        'Measurement plane',
        project.plane.orientation === 'vertical'
          ? `Vertical (facing the audience) at ${project.plane.heightM} m`
          : `Horizontal at ${project.plane.heightM} m`,
      ],
      ['Grid', `${input.grid.cols} × ${input.grid.rows} at ${input.grid.spacing} m`],
      [
        'Design level',
        `${formatLevel(project.targets.targetLux, unit)} ${u} (dark below ${project.targets.darkFraction}×, hot above ${project.targets.hotMultiple}×)`,
      ],
      ['Fixtures', `${project.fixtures.filter((f) => f.enabled).length} live of ${project.fixtures.length}`],
    ],
    theme: 'grid',
    headStyles: { fillColor: [14, 41, 66] },
    styles: { fontSize: 9, cellPadding: 1.6 },
  });

  // --- levels --------------------------------------------------------------
  autoTable(doc, {
    startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6,
    head: [['Levels on the measurement plane', '']],
    body: levelsFor(metrics, unit),
    theme: 'grid',
    headStyles: { fillColor: [14, 41, 66] },
    styles: { fontSize: 9, cellPadding: 1.6 },
    columnStyles: { 1: { halign: 'right', font: 'courier' } },
  });

  // --- problem areas -------------------------------------------------------
  if (blobs.length > 0) {
    autoTable(doc, {
      startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6,
      head: [['', 'Area m²', 'Centre X', 'Centre Y', `Peak ${u}`]],
      body: blobs
        .slice(0, 12)
        .map((b) => [
          b.kind === 'dark' ? 'Dark spot' : 'Hot spot',
          b.areaM2.toFixed(2),
          b.cx.toFixed(2),
          b.cy.toFixed(2),
          formatLevel(b.peakLux, unit),
        ]),
      theme: 'grid',
      headStyles: { fillColor: [14, 41, 66] },
      styles: { fontSize: 9, cellPadding: 1.6 },
      columnStyles: {
        1: { halign: 'right', font: 'courier' },
        2: { halign: 'right', font: 'courier' },
        3: { halign: 'right', font: 'courier' },
        4: { halign: 'right', font: 'courier' },
      },
    });
  }

  // --- fixture schedule ----------------------------------------------------
  doc.addPage();
  doc.setFontSize(13);
  doc.text('Fixture schedule', 14, 18);

  const structures = new Map(project.structures.map((s) => [s.id, s]));
  const rows = project.fixtures.map((f) => {
    const model = models.get(f.modelId);
    const optic = model ? findOptic(model, f.opticId) : undefined;
    const { pan, tilt } = panTiltToAim(f.position, f.aim);
    const contribution = perFixtureAvg.get(f.id);

    return [
      f.channel,
      structures.get(f.structureId)?.name ?? '—',
      model ? `${model.manufacturer} ${model.name}` : f.modelId,
      optic?.label ?? '—',
      `${f.position.x.toFixed(2)}, ${f.position.y.toFixed(2)}, ${f.position.z.toFixed(2)}`,
      `${f.aim.x.toFixed(2)}, ${f.aim.y.toFixed(2)}, ${f.aim.z.toFixed(2)}`,
      `${pan.toFixed(0)}° / ${tilt.toFixed(0)}°`,
      f.zoom !== undefined ? `${f.zoom.toFixed(0)}°` : '—',
      `${Math.round(f.level * 100)}%`,
      `${Math.round(f.transmission * 100)}%`,
      optic?.photometrics.provenance ?? '—',
      contribution !== undefined ? formatLevel(contribution, unit) : '—',
    ];
  });

  autoTable(doc, {
    startY: 24,
    head: [
      [
        'Ch',
        'Bar',
        'Fixture',
        'Optic',
        'Position x,y,z',
        'Aim x,y,z',
        'Pan/Tilt',
        'Zoom',
        'Level',
        'Gel',
        'Data',
        `Avg ${u}`,
      ],
    ],
    body: rows,
    theme: 'grid',
    headStyles: { fillColor: [14, 41, 66] },
    styles: { fontSize: 7, cellPadding: 1.1 },
  });

  // --- structures ----------------------------------------------------------
  autoTable(doc, {
    startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6,
    head: [['Structure', 'Type', 'Run', 'Height', 'Fixtures', 'Load kg', 'SWL kg']],
    body: project.structures.map((s) => {
      const on = project.fixtures.filter((f) => f.structureId === s.id);
      const load = on.reduce((sum, f) => sum + (models.get(f.modelId)?.weightKg ?? 0), 0);
      return [
        s.name,
        s.kind,
        `${runLength(s.from, s.to).toFixed(2)} m`,
        `${Math.max(s.from.z, s.to.z).toFixed(2)} m`,
        String(on.length),
        load.toFixed(1),
        s.swlKg !== undefined ? String(s.swlKg) : '—',
      ];
    }),
    theme: 'grid',
    headStyles: { fillColor: [14, 41, 66] },
    styles: { fontSize: 8, cellPadding: 1.4 },
  });

  // --- checks --------------------------------------------------------------
  if (issues.length > 0) {
    autoTable(doc, {
      startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6,
      head: [['Rig checks', '']],
      body: issues.map((i) => [i.severity, i.message]),
      theme: 'grid',
      headStyles: { fillColor: [14, 41, 66] },
      styles: { fontSize: 8, cellPadding: 1.4 },
      columnStyles: { 0: { cellWidth: 20 } },
    });
  }

  // --- the caveat, on every page ------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFontSize(6.5);
    doc.setTextColor(120);
    doc.text(doc.splitTextToSize(MODEL_CAVEAT, 182), 14, 280);
    doc.text(`${page} / ${pages}`, 196, 292, { align: 'right' });
    doc.setTextColor(0);
  }

  return doc;
}

