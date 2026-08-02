# AGENTS.md — bringing an LLM up to speed on stagewash

Orientation for an AI assistant (or a new human) picking this up cold. `README.md` is
the user-facing story; this file is the map, the invariants, and — most importantly —
**what is verified and what is not**.

---

## 1. What this is

A **static browser app** for modelling a stage and a lighting rig, and calculating the
illuminance on the stage before anyone goes to the venue. React 19 + TypeScript + Vite,
three.js for the wireframe plot, deployed to Cloudflare as a Worker that serves static
assets. Everything runs client-side; there is no backend and there should never be one —
the Worker exists only to serve `dist/`, not to run code.

Private repo, MIT licence text in `LICENSE`.

The reference for the 3D view is **ArrayCalc's plot window**: an engineering diagram you
can rotate, not a render. Photorealism is explicitly out of scope and would be worse — it
implies a precision the model does not have.

## 2. Layout

```
src/
  domain/        The whole model. No React in here, ever. No I/O, no side effects.
    types.ts         Data shapes, coordinate conventions, the provenance contract
    geometry.ts      Vectors, pan/tilt, the fixture frame, beam footprints
    photometry/
      distribution.ts  Sampling a distribution; flux integration; zoom scaling
      estimator.ts     THE ASSUMPTIONS LIVE HERE — synthesising a beam from a datasheet
      ies.ts           IESNA LM-63 reader
      ldt.ts           EULUMDAT reader
    rig.ts           Document -> solvable fixtures, plus every rig check
    solver.ts        THE IMPORTANT FILE — the illuminance grid solve
    metrics.ts       Statistics, uniformity, hot/dark blob finding, units
  data/          The library. Every entry carries provenance + a named source.
  state/         zustand store, the default rig, the solver client
  workers/       The solve, off the main thread
  render/        three.js scene + the heatmap colour ramp
  ui/            React. Presentation only — no photometry arithmetic in here.
  export/        common.ts (CSV + types, no jsPDF) and pdf.ts (dynamically imported)
```

**`domain/` must stay React-free and side-effect-free.** It is the tested part, and the
part the product's correctness rests on. If you find yourself importing a hook into
`domain/`, the design has gone wrong.

**`ui/` must not do photometric arithmetic.** The 3D view, the report and the solver have
to agree, and the only way to guarantee that is one implementation.

## 3. Build, run, test

```bash
npm install
npm run dev        # vite dev server (port 5199 via .claude/launch.json)
npm test           # vitest — 105 tests
npm run typecheck  # tsc -b across app + node + test configs
npm run lint       # oxlint
npm run build      # tsc -b && vite build -> dist/
npm run deploy     # build + wrangler deploy (Worker + static assets, not Pages)
```

**tsconfig trap:** tests are Node-flavoured and are excluded from `tsconfig.app.json`,
which is browser-only. They are typechecked by `tsconfig.test.json`. A test that imports
from `src/state/` needs that path adding to the test config's `include` or `tsc -b` fails
with TS6307 — which reads like a missing file rather than a config gap.

## 4. The physics, and its limits

The solve is, in full:

```
E = Σ  I(C, γ) · cos ι / d²
```

Inverse square, the cosine law, and each fixture's real intensity distribution, summed
over fixtures, times level and gel transmission.

**Not modelled, deliberately:** inter-reflection from deck/walls/cyc, atmospheric haze,
shutter cuts, gobos, barn doors, and shadowing by people or scenery. This is a *direct*
illuminance calculation. On a black stage that is the right model; in a white studio,
inter-reflection can add a third again. `MODEL_CAVEAT` in `export/common.ts` says this in
the same words, it is printed on every page of every PDF, and it is in the metrics strip.
**Do not quietly widen the claims.**

### The one thing that surprises people

Front light reads *weak* on a horizontal plane and strong on a vertical one, because it
arrives nearly edge-on to the floor. On the default rig the upstage overheads measure
about 4x the FOH on the floor map, and the ranking reverses on the face plane — where the
backlight PARs correctly contribute exactly **zero**. That asymmetry is the single most
useful thing this app shows, and `defaultRig.test.ts` pins it. Do not "fix" it.

## 5. Provenance — the invariant the whole app rests on

Every photometric carries `provenance` and a `source` string, surfaced as a badge in the
UI at the moment the user picks a fixture.

| level | meaning |
|---|---|
| `measured` | Read from a manufacturer IES/LDT file. |
| `published` | Beam angle, field angle and centre-beam candela transcribed from a **named** datasheet; only the roll-off between those anchors is modelled. |
| `estimated` | A generic archetype synthesised by `estimator.ts`. Indicative only. |

**No candela figure in `data/fixtures.ts` is invented.** There is deliberately no fourth
category of "real product, guessed numbers" — a library full of plausible-looking entries
for fixtures nobody measured is worse than a small honest one, because the badge is the
only thing standing between a user and a confident wrong answer. `calibration.test.ts`
enforces that any entry containing an estimate is named `Generic`.

## 6. Calibration — what is actually verified

`src/domain/__tests__/calibration.test.ts` holds **eight published photometric rows
transcribed from ETC Source Four datasheets** (36°, jr 26°, Zoom at 15/23/30°, PAR MCM
VNSP, PARNel spot and flood). They are the reason the constants in `estimator.ts` hold
the values they do.

**Fix the model, never the table.** If a change to that table makes a test pass, the
change is wrong.

Measured accuracy, stated honestly:

| given | error |
|---|---|
| the datasheet's own field lumens + both angles | mean −3.3%, worst 10.5% |
| bare lamp lumens + both angles (what a user typing a custom fixture has) | mean −2.4%, worst −23.7% |

The residual is dominated by `OPTICAL_EFFICIENCY` being one number standing in for a real
**42–65%** range. No work on the shape function will close it. The answer to "I need this
to be right" is always *import the IES file*.

Three calibration findings worth not re-learning:

1. **Optical efficiency for a profile is ~55%, not ~28%.** The first cut of that table
   reasoned that the gate and shutters throw most of the lamp away. That is wrong by
   better than a factor of two — a dichroic reflector and a centred filament recover far
   more than intuition suggests — and it would have put every estimated profile at less
   than half its real output.
2. **Datasheets quote FIELD lumens, not total flux.** Reading one as the other made every
   estimate ~10% low — visible as a *one-sided* error across all eight fixtures, which is
   the signature of a systematic bug rather than model noise. `lumensBasis` models it.
   LED fixtures are the exception: their published output is an integrating-sphere total,
   so `lumensAtLens` defaults the basis to `total`.
3. **The PAR MCM datasheet measures with an HPL 575 while the rest of the range uses an
   HPL 750.** Assuming one lamp for the whole range put its efficiency at 36% against the
   47% ETC quote. The internal-consistency test caught it.

The three measured Zoom positions independently confirm the zoom model: field lumens stay
within 7% across 16°/23°/31° while centre-beam candela tracks the inverse square of the
angle ratio to 0.3%. So `scaleZoom` conserves **flux**, exactly — not peak intensity.

## 6a. Both parsers are validated against real manufacturer files

`__tests__/fixtures/README.md` records exactly which files and why.

### EULUMDAT — `ldtReal.test.ts`

Six real files covering **every** symmetry case the format defines (`Isym` 0–4) and all
three `Ityp` values, from the MIT-licensed test corpus of `123VincentB/eulumdat-py`.

The check worth understanding: a EULUMDAT header declares the lamp's total flux, and the
table separately carries candela in **cd/1000 lm**. Those two are independent — one is
typed in, the other measured — so integrating the parsed table over the sphere and
comparing it against the declared flux exercises the scaling, the angle assignment and,
above all, the **symmetry expansion**, because mirroring the wrong planes changes the
integral. It lands **within 0.1%** on every file whose luminaire emits all of its lamp's
light.

The best single file is `ldt-isym0-lor-88pct.ldt`: a LEDiL optic declaring a 400 lm lamp
and a light output ratio of **88.63%** on header line 23. Integrating its table gives
88.7% of 400 lm. Nothing in the reader knows about that ratio — it falls out of the
measured data — which rules out the whole class of bug where a parser quietly scales a
table to make the flux "come out right".

### IES — `iesReal.test.ts`

`iesReal.test.ts`. The full **"Source Four HPL IES Photometry Data Files (LM-63-02
Format)"** bundle from etcconnect.com — **132 real files** — parses with **zero failures
and zero warnings**. Three are vendored in `__tests__/fixtures/` (144 kB); point
`STAGEWASH_IES_DIR` at an extract of the bundle to sweep the lot:

```bash
STAGEWASH_IES_DIR=/path/to/extract npx vitest run iesReal
```

Real files exercised things no synthetic fixture here happened to: a candela multiplier
of **96.96**, **181 C planes** encoded as a full 0–360 sweep, keywords with **no space
after the bracket** (`[TEST]#7`), rows wrapped mid-number at column 80, and
Windows-codepage degree signs — hence reading as `latin1`, not `utf8`, or the citation
string in the UI becomes mojibake.

### Datasheet and IES disagree, for the same fixture

Cross-checking the parsed files against the datasheet figures in `calibration.test.ts`:

| fixture | datasheet cd | IES cd | Δ |
|---|---|---|---|
| PARNel flood | 47,050 | 47,028 | −0.05% |
| PAR MCM VNSP | 343,440 | 343,912 | +0.1% |
| PARNel spot | 190,390 | 187,964 | −1.3% |
| S4jr 26° | 91,480 | 91,053 | −0.5% |
| Zoom 30° | 105,690 | 99,907 | −5.5% |
| Zoom 23° | 181,685 | 203,307 | +11.9% |
| S4 36° | 90,885 | 103,167 | +13.5% |
| Zoom 15° | 395,560 | 334,125 | −15.5% |

Four agree to within about 1%, which is strong evidence the reader is correct — a parser
bug in the multiplier or the table indexing would put *every* file out by a similar
factor, not four of eight spot on. The rest is **ETC disagreeing with ETC**: the files
were tested 2003 and issued 2007, the datasheets are a different revision, and the S4 36°
beam angle is 21.3° measured against 27° published while its *field* angle matches (32.9°
vs 34°).

Two consequences. First, ±15% between two first-party sources for the same fixture is the
real floor on accuracy here, and it is worth more than any refinement to the estimator.
Second, **the datasheet-derived `published` entries in `data/fixtures.ts` were left as
they are** — they are correctly cited transcriptions, and replacing them with IES-derived
numbers would embed ETC's photometric data in the shipped bundle, which is a
redistribution question rather than a technical one. Import the file to get `measured`.

## 7. Traps that already cost time

- **A measured table's cutoff is its last *live* row, not its last measured row.**
  Photometric files are sampled over the whole hemisphere whatever the fixture does —
  ETC's run to 90° in 2° steps — so a 36° spot has ~30 rows of literal `0.00`. Taking 90°
  at face value defeats the solver's early-out and it evaluates the full table, two binary
  searches and an `atan2`, across most of the stage to add nothing. Four imported fixtures
  took a solve from 3.5 ms to 30.8 ms; trimming trailing zero rows in `maxGammaOf` brought
  it back to ~1.3 ms. The trim is lossless by construction, and `iesReal.test.ts` asserts
  that everything past the reported cutoff really is zero in every C plane.
- **`scaleZoom` conserves flux exactly, by integration, not by the ratio-squared rule.**
  That rule assumes `sin γ ≈ γ` and is 0.8% out at a 45° field, worse wider. The
  correction costs one integration per zoom change, which happens on user input, never on
  the solver's hot path.
- **`solver.ts` duplicates its inner loop in `illuminanceAtPoint` on purpose** — the loop
  cannot afford the call or the object allocation. `solver.test.ts` pins the two against
  each other at every cell of a grid. Do not "de-duplicate" them without keeping that test.
- **The grid is a `Float32Array`.** Comparisons against it need a *relative* tolerance;
  an absolute one passes at the dark edges and fails under the hot spots, which reads
  exactly like a solver bug.
- **A tabulated distribution returns 0 above its last sampled gamma, never the edge value.**
  Clamping instead smears the last ring of candela over the whole upper hemisphere, which
  shows up as a stage lit from below by a downlight.
- **IES Type A and Type B files are rejected, not read.** Their angles come off different
  axes; reading one as Type C gives a wrong answer that looks entirely plausible.
- **The IES numeric section is free-form whitespace.** Parse it as one flat token stream
  after the `TILT=` line. Reading it line by line is the commonest way to get LM-63 wrong.
- **EULUMDAT stores fewer C planes than it lists angles for**, depending on `Isym`.
  Reading `Mc` planes of intensities runs off the end of any symmetric fitting.
- **three.js is z-up here.** The whole scene is built in domain coordinates with
  `camera.up = +z`. Do not add per-object rotations — a half-applied coordinate
  conversion is invisible until something is mirrored.
- **`fixtureFrame` falls back to +y as its reference when the beam is within a whisker of
  vertical.** Without that, a fixture tilted to exactly −90° (a downlight, very common)
  gets a degenerate frame and an asymmetric distribution spins arbitrarily.
- **Beam cones are additively blended and bleach the heatmap.** Default opacity is 0.045
  for that reason. Raising it is a user choice, not a default.
- **The heatmap is a `DataTexture`, whose `flipY` is `false`** unlike an image texture.
  `defaultRig.test.ts` has a deliberately asymmetric downlight test that fails if either
  axis is mirrored — a near-symmetric rig hides a flip completely.

## 8. What has NOT been verified

Be straight about this in any report or release note.

- **Neither parser has been validated against a *stage-fixture* EULUMDAT file.** `ldt.ts`
  is validated against six real files covering every `Isym` case (see §6a), but they are
  architectural and street fittings — Tulux, LEDiL — because entertainment manufacturers
  publish IES. A theatre fixture's `.ldt` should be fine; nothing in the format changes.
- **No result has been checked against a light meter.** Nothing here has been near a
  stage.
- **The `Generic` archetypes are archetypes.** The fresnel, PC, cyc and batten efficiency
  and beam-ratio constants have **no measured source** — only the profile, PAR and
  fresnel-adjacent (PARNel) figures are calibrated. They are marked in `estimator.ts`.
- **The cyc archetype does not model vertical asymmetry**, which is the entire point of a
  real cyc unit. Import the manufacturer file if the evenness of a cloth is the question.
- **A batten is modelled as a point source** at its centre, which overstates levels closer
  than about twice its length.
- **Colour mixing is not modelled.** A saturated colour on an LED fixture can be a fifth
  of its white output; use the fixture's transmission control to account for it.
- **Structural loading counts fixture weight only** — no clamps, cable, or the truss
  itself — and is a sanity check, not an engineering calculation.

## 9. Conventions

Repo conventions per the fleet: `CLAUDE.md` is the command reference, this file is the
mental model. Deployment is a Cloudflare **Worker with static assets** (`wrangler.toml`
`[assets]`), never Pages — the two config keys are not interchangeable. Deploy with
`cf-run npx wrangler deploy` so the keychain token is used; never `wrangler login`.
