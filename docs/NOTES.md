# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*stagewash — browser stage-lighting coverage calculator at ~/Projects/stagewash; PRIVATE repo, LIVE on a subdomain, photometrics calibrated against ETC datasheets*

**PUBLIC since 2026-08-05** — the private-repo statements below are historical; the repo, its Docker packaging and its `/software` page are all live. See [browser tools published](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/project_browser_tools_published.md).

Browser app for modelling a stage and lighting rig and calculating illuminance on the
deck before going to the venue. React 19 + TS + Vite + zustand + three.js, static SPA on
a Cloudflare Worker. `~/Projects/stagewash`, **PRIVATE** at
github.com/stoatworks-labs/stagewash, **LIVE at https://stagewash.stoatworks-labs.com**
since 2026-08-02. 130 tests. Dev server port 5199.

**On the website since 2026-08-02** — the tenth entry on `/web-tools` and the only
Lighting one, so it is what makes that discipline exist there at all (see
[stoatworks website](https://github.com/stoatworks-labs/stoatworks-website/blob/main/docs/NOTES.md) (`stoatworks-website`)). It has a `projects.json` entry (`public: false`, so it
does NOT appear on `/software`), a `webtools.json` entry, page copy in `web-tools.astro`
keyed by slug, and `docs/screenshots/stagewash.png` in **this** repo — a 1600×1000
headless capture of the live default rig, which the website's `scripts/shots.json` crops
to frame the plot. No video yet.

**The physics is direct illuminance only** — `E = Σ I(C,γ)·cos ι / d²`. No
inter-reflection, haze, shutter cuts, gobos or shadowing. Right for a black stage, wrong
for a white studio (bounce adds ~a third). `MODEL_CAVEAT` prints on every PDF page.

**The headline feature is the horizontal/vertical plane toggle.** Front light reads weak
on a floor map because it arrives nearly edge-on, and strong on a face plane; overheads
do the reverse. On the default rig the backlight PARs contribute *exactly zero* to the
face plane. A rig can look even on the floor and be flat on faces — that inversion is the
most useful thing the app shows, and `defaultRig.test.ts` pins it. Don't "fix" it.

**Calibrated, not guessed** — `calibration.test.ts` holds 8 published photometric rows
transcribed from ETC Source Four datasheets (36°, jr 26°, Zoom 15/23/30°, PAR MCM VNSP,
PARNel spot/flood). **Fix the model, never the table.** Three findings worth not
re-learning:
- **Optical efficiency for a profile is ~55%, measured 47–65%** — NOT the ~28% intuition
  suggests from "the gate throws most of the lamp away". Out by a factor of two.
- **Datasheets quote FIELD lumens, not total flux.** Reading one as the other made every
  estimate ~10% low — a *one-sided* error across all 8 fixtures, the signature of a
  systematic bug rather than noise. Fixing it took mean bias −9.4% → −3.3%. LED fixtures
  are the exception: their published output is an integrating-sphere total.
- **The PAR MCM sheet uses an HPL 575 while the rest of the range uses an HPL 750.**
  Assuming one lamp for the range put its efficiency at 36% vs ETC's quoted 47%.

Estimator accuracy, stated honestly: **within ~10%** given the maker's own field lumens
and angles, **within ~25%** from bare lamp lumens alone. Residual is dominated by optical
efficiency being one number for a real 42–65% range — unclosable. Answer to "it must be
right" is always *import the IES file*.

**Provenance is the core invariant.** `measured` (imported IES/LDT) / `published`
(datasheet-transcribed anchors) / `estimated` (archetype). No candela figure in
`data/fixtures.ts` is invented, and there is deliberately no "real product, guessed
numbers" category — a test enforces that anything containing an estimate is named
`Generic`.

**Parsers ARE validated against real files** (2026-08-02). ETC's whole published Source
Four bundle — **132 LM-63-02 files**, from etcconnect.com `WorkArea/DownloadAsset.aspx?id=10737458941`
— parses with zero failures/warnings; `STAGEWASH_IES_DIR=<extract> npx vitest run iesReal`
sweeps it. EULUMDAT validated on 6 real files covering **every Isym case**, from the
MIT-licensed corpus of `123VincentB/eulumdat-py`. **The killer LDT check:** header declares
lamp flux, table carries cd/1000 lm *independently* — integrating the table must return the
declared flux (within 0.1%), which tests scaling + angles + symmetry expansion at once. One
LEDiL file declares an 88.63% light output ratio and the integration recovers 88.7% without
the reader knowing that number exists.

**ETC's own IES files and ETC's own datasheets disagree** for the same fixture: 4 of 8 agree
within 1%, the rest differ 5–15% (different revisions; files tested 2003, issued 2007). The
S4 36° is 21.3° beam measured vs 27° published. **±15% between two first-party sources is the
real accuracy floor** — bigger than anything the maths contributes. Library keeps the
datasheet-derived `published` entries; import the file for `measured`.

**Real IES files exposed a 20x perf bug:** photometric files are sampled over the whole
hemisphere regardless of fixture, so a 36° spot has ~30 rows of literal `0.00` out to 90°.
`maxGammaOf` took that at face value, defeating the solver's early-out — 4 imported fixtures
took a solve 3.5 ms → 30.8 ms. Trimming trailing zero rows is lossless: back to ~1.3 ms.

**NOT verified:** nothing checked against a light meter; no *stage-fixture* .ldt (the real
LDT corpus is architectural/street — entertainment makers publish IES). Fresnel/PC/cyc/batten efficiency constants have no measured
source. Cyc archetype doesn't model vertical asymmetry, which is a real cyc unit's whole
point. Batten is a point source. No colour mixing.

Traps: `scaleZoom` conserves **flux** exactly by integration — the ratio-squared rule is
0.8% out at 45°. `solver.ts` duplicates its inner loop in `illuminanceAtPoint` on purpose
(a test pins them). Grid is Float32 so comparisons need a *relative* tolerance. Tabulated
distributions return 0 past their last gamma, never the edge value. IES Type A/B are
rejected, not read. IES numerics are free-form whitespace — parse as one token stream.
three.js is z-up here. Additive beam cones bleach the heatmap (default opacity 0.045).
`DataTexture` has `flipY: false` unlike an image texture — a mirrored heatmap is
invisible on a symmetric rig, hence the asymmetric downlight test.

See [agents md convention](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_agents_md_convention.md), [cloudflare access](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_cloudflare_access.md),
[arraycad](https://github.com/stoatworks-labs/arraycad/blob/main/docs/NOTES.md) (`arraycad`) (the 3D plot idiom came from ArrayCalc's plot window).
