# Test fixtures — real photometric files

Real manufacturer photometric files, kept here so the parsers are tested against
what vendors actually ship rather than only against synthetic files this repo
writes for itself. See `iesReal.test.ts` and `ldtReal.test.ts`.

## IES (`.ies`)

Three files from ETC's published **"Source Four HPL IES Photometry Data Files
(LM-63-02 Format)"** bundle, downloaded from etcconnect.com. The complete bundle
is 132 files and all 132 parse with zero failures and zero warnings; three are
kept here because the whole set is ~6 MB. To sweep the lot, extract the bundle
and run:

```bash
STAGEWASH_IES_DIR=/path/to/extract npx vitest run iesReal
```

| file | why this one |
|---|---|
| `etc-s4-36-hpl750-115.ies` | Candela multiplier 96.96, 181 C planes as a full 0–360 sweep, `[TEST]#7` with no space after the bracket, ~30 trailing all-zero gamma rows |
| `etc-s4-par-ea-mfl-hpl575-115.ies` | Genuinely oval beam — the only way to catch C being ignored or the candela block being indexed the wrong way round |
| `etc-s4-parnel-flood-hpl750-115.ies` | Agrees with its own datasheet to better than 0.1%, so it pins absolute scale |

Copyright Electronic Theatre Controls, Inc. Published by ETC for use in lighting
design software; included here solely as parser test input.

## EULUMDAT (`.ldt`)

Six files from the test corpus of
[`123VincentB/eulumdat-py`](https://github.com/123VincentB/eulumdat-py) (MIT), an
independent EULUMDAT implementation. Chosen to cover **every** symmetry case the
format defines, from manufacturers including Tulux and LEDiL.

| file | `Isym` | why this one |
|---|---|---|
| `ldt-isym1-point-symmetric.ldt` | 1 | One stored plane however many C angles the header lists |
| `ldt-isym0-asymmetric.ldt` | 0 | No mirroring — every plane stored |
| `ldt-isym2-c0c180.ldt` | 2 | Mirrored about C0–C180 |
| `ldt-isym3-c90c270.ldt` | 3 | Mirrored about C90–C270 — the awkward one, its stored planes start at C90 rather than C0 |
| `ldt-isym4-quadrant.ldt` | 4 | Mirrored in both planes |
| `ldt-isym0-lor-88pct.ldt` | 0 | Declares a light output ratio of 88.63%, which the integrated candela table has to reproduce |

**What these actually test.** A EULUMDAT header declares the lamp's total flux;
the table separately carries candela in cd/1000 lm. The two are independent — one
is typed in, the other measured — so integrating the parsed table over the sphere
and comparing it to the declared flux exercises the cd/1000 lm scaling, the angle
assignment and, above all, the symmetry expansion, since mirroring the wrong
planes changes the integral. It lands within 0.1% on every file whose luminaire
emits all of its lamp's light, and on `ldt-isym0-lor-88pct.ldt` it independently
recovers that luminaire's own stated 88.63% output ratio.
