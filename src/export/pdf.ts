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
import { chooseScale, rampRgb, type HeatmapScale } from '../render/heatmap';
import { renderReportPlots, type ReportPlot } from '../render/plots';
import { MODEL_CAVEAT, type ReportInput } from './common';

/** Plots page furniture, mm. A4 is 210 × 297; the text block is 14..196. */
const LEFT = 14;
const CONTENT_WIDTH = 182;
const GUTTER = 5;
const HALF_WIDTH = (CONTENT_WIDTH - GUTTER) / 2;
const PLAN_TOP = 28.5;
const PLAN_BOX_HEIGHT = 132;
const ROW_BOX_HEIGHT = 68;

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

/**
 * The plots page: the plan heatmap large, then the isometric view and the
 * wireframe layout beneath it.
 *
 * The plan gets the space because it is the one a designer reads decisions off.
 * The isometric is there to show the *rig* — where the light is coming from,
 * which a plan flattens away entirely — and the wireframe is the key to the
 * plan: same camera, same frame, so a pool on the heatmap sits over the fixture
 * that made it, with the channel number next to it.
 *
 * Silently skipped when there are no plots, which is what a browser with no
 * WebGL gives us. The numbers are the report; the pictures illustrate it.
 */
function drawPlots(doc: jsPDF, input: ReportInput): void {
  const { project, grid, unit, scaleMaxLux } = input;

  const plots = renderReportPlots(project, grid, scaleMaxLux);
  const plan = plots.find((p) => p.key === 'plan');
  const iso = plots.find((p) => p.key === 'iso');
  const layout = plots.find((p) => p.key === 'layout');
  if (!plan || !iso || !layout) return;

  doc.addPage();
  doc.setFontSize(13);
  doc.text('Coverage plots', LEFT, 18);

  doc.setFontSize(7.5);
  doc.setTextColor(110);
  doc.text(
    doc.splitTextToSize(
      'Drawn from the same model as the calculation. The plan and the layout are parallel projections seen from '
        + 'above, downstage at the bottom, so every fixture sits on its own position on the deck.',
      CONTENT_WIDTH,
    ),
    LEFT,
    22.5,
  );
  doc.setTextColor(0);

  // Fixed boxes, so the page reads the same whatever shape the rig is; the
  // pictures are centred inside them at their own aspect.
  const planBox = placeImage(doc, plan, LEFT, PLAN_TOP, CONTENT_WIDTH, PLAN_BOX_HEIGHT);

  const planeLabel =
    project.plane.orientation === 'vertical'
      ? `vertical plane, facing the audience, at ${project.plane.heightM.toFixed(2)} m`
      : `horizontal plane at ${project.plane.heightM.toFixed(2)} m`;

  const legendTop = PLAN_TOP + PLAN_BOX_HEIGHT + 7;
  caption(doc, `Illuminance on the ${planeLabel}.`, planBox.x, legendTop - 2.5);
  // Aligned to the picture rather than the text block: a key that is wider than
  // the map it belongs to reads as a separate figure.
  drawLegend(doc, planBox.x, legendTop, planBox.width, 4.5, chooseScale(grid, scaleMaxLux), unit);

  const rowTop = legendTop + 17;
  const isoBox = placeImage(doc, iso, LEFT, rowTop, HALF_WIDTH, ROW_BOX_HEIGHT);
  const layoutBox = placeImage(
    doc,
    layout,
    LEFT + HALF_WIDTH + GUTTER,
    rowTop,
    HALF_WIDTH,
    ROW_BOX_HEIGHT,
  );
  drawPlotLabels(doc, layout, layoutBox);

  const captionY = rowTop + ROW_BOX_HEIGHT + 4;
  caption(doc, 'Isometric — the rig, its beams and where they land.', isoBox.x, captionY);
  caption(doc, 'Layout — the same frame as the plan, by channel.', layoutBox.x, captionY);
}

interface PlacedImage {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centre a plot inside a box at its own aspect ratio, and report where it landed. */
function placeImage(
  doc: jsPDF,
  plot: ReportPlot,
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
): PlacedImage {
  const aspect = plot.widthPx / plot.heightPx;
  let width = boxWidth;
  let height = boxWidth / aspect;
  if (height > boxHeight) {
    height = boxHeight;
    width = boxHeight * aspect;
  }

  const placed = {
    x: boxX + (boxWidth - width) / 2,
    y: boxY + (boxHeight - height) / 2,
    width,
    height,
  };
  doc.addImage(plot.dataUrl, 'PNG', placed.x, placed.y, placed.width, placed.height, undefined, 'FAST');
  return placed;
}

function caption(doc: jsPDF, text: string, x: number, y: number): void {
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text(text, x, y);
  doc.setTextColor(0);
}

/**
 * The colour key. Without it a heatmap is a pretty picture rather than a
 * measurement, and the ramp has to be sampled from the same function the
 * texture was built with — hence `rampRgb` rather than a hand-copied set of
 * stops that would rot the first time the ramp changed.
 */
function drawLegend(
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  height: number,
  scale: HeatmapScale,
  unit: Unit,
): void {
  const steps = 64;
  const stepWidth = width / steps;

  for (let i = 0; i < steps; i++) {
    const [r, g, b] = rampRgb((i + 0.5) / steps, 'viridis');
    doc.setFillColor(r, g, b);
    // A whisker of overlap: abutting rectangles hairline-crack at some zoom
    // levels in every PDF viewer, and the crack reads as a contour.
    doc.rect(x + i * stepWidth, y, stepWidth + 0.06, height, 'F');
  }

  doc.setDrawColor(150);
  doc.setLineWidth(0.15);
  doc.rect(x, y, width, height);

  doc.setFontSize(7);
  doc.setTextColor(110);
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const label = `${formatLevel(scale.min + (scale.max - scale.min) * t, unit)}${i === ticks - 1 ? ` ${unitLabel(unit)}` : ''}`;
    doc.text(label, x + t * width, y + height + 3.4, {
      align: i === 0 ? 'left' : i === ticks - 1 ? 'right' : 'center',
    });
  }
  doc.setTextColor(0);
}

/**
 * Channel numbers over the wireframe.
 *
 * Positions come back from the render in frame fractions, so the type is set by
 * the PDF and stays sharp at any zoom. Labels that would collide are dropped
 * rather than drawn on top of each other — on a tightly-spaced bar the run of
 * numbers becomes an illegible smear, and a thinned-out set of legible ones is
 * more use than a complete set of unreadable ones. The schedule has them all.
 */
function drawPlotLabels(doc: jsPDF, plot: ReportPlot, box: PlacedImage): void {
  const drawn: Array<[number, number]> = [];

  doc.setFontSize(5);
  doc.setTextColor(255);

  for (const label of plot.labels) {
    const x = box.x + label.u * box.width;
    const y = box.y + label.v * box.height;
    if (drawn.some(([dx, dy]) => Math.abs(dx - x) < 3.2 && Math.abs(dy - y) < 2)) continue;
    drawn.push([x, y]);
    doc.text(label.text, x + 1.1, y + 0.8);
  }

  doc.setTextColor(0);
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

  // --- plots ---------------------------------------------------------------
  drawPlots(doc, input);

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

