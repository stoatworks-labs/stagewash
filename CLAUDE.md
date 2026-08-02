# CLAUDE.md — command reference

See `AGENTS.md` for the mental model, the invariants and the traps. This file is
commands only.

```bash
npm install
npm run dev        # vite dev server, port 5199
npm test           # vitest — 105 tests
npm run bench      # vitest bench — solver performance
npm run typecheck  # tsc -b (app + node + test projects)
npm run lint       # oxlint
npm run build      # tsc -b && vite build -> dist/
npm run deploy     # build + wrangler deploy  (Worker + static assets)
```

Deploy needs the keychain token, not `wrangler login`:

```bash
cf-run npx wrangler deploy
```

Key files:

- `src/domain/solver.ts` — the illuminance grid solve. The hot path; its inner loop is
  deliberately duplicated in `illuminanceAtPoint` and pinned by `solver.test.ts`.
- `src/domain/photometry/estimator.ts` — every assumption in the app. `OPTICAL_EFFICIENCY`
  and `TYPICAL_BEAM_FIELD_RATIO` are calibrated against ETC datasheets, not guessed.
- `src/domain/__tests__/calibration.test.ts` — the eight published photometric rows the
  estimator is calibrated against. **Fix the model, never the table.**
- `src/data/fixtures.ts` — the library. Every optic needs `provenance` + a named `source`.
  Anything containing an estimate must be named `Generic`.
- `src/domain/__tests__/defaultRig.test.ts` — grid orientation (catches a mirrored
  heatmap) and the front-light-versus-top-light behaviour.
- `src/domain/photometry/distribution.ts` — `buildCosTable` is the only place exactness is
  traded for speed. Both `solve` and `illuminanceAtPoint` must use it or they diverge.
- `src/domain/__tests__/cosTable.test.ts` — measures that trade (better than 1e-5 of peak
  inside the beam). `src/domain/__bench__/solver.bench.ts` is the performance baseline.

Write a PDF to disk while testing, instead of downloading it:

```bash
npx vitest run src/domain/__tests__/calibration.test.ts
```
