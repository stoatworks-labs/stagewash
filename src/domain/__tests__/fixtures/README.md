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

## MVR (`.mvr`)

Three files from the test corpus of
[`open-stage/python-mvr`](https://github.com/open-stage/python-mvr) (MIT), an
independent MVR implementation, each written by a different application. See
`mvrReal.test.ts`.

| file | written by | why this one |
|---|---|---|
| `mvr-blenderdmx-basic-fixture.mvr` | BlenderDMX | One fixture with a GDTF that has real beam figures (60° beam, 90° field, 7,000 lm LED): the estimate path end to end |
| `mvr-capture-demo-show-trimmed.mvr` | Capture | 76 fixtures in five types and no focus points. Its towers and floor units are the evidence that MVR's matrix is columns. Its GDTFs are stubs with no beam |
| `mvr-vectorworks-scene-objects-trimmed.mvr` | Vectorworks | 72 fixtures, each with a focus point. `GDTFSpec` has no `.gdtf` extension, and the GDTF beam is the format's placeholder defaults |

The BlenderDMX file is unchanged (24 kB). The other two are **trimmed**:
`GeneralSceneDescription.xml` and every `.gdtf` are kept byte for byte, and the 3D
models, which stagewash never reads, are dropped. That is 891 `.3ds` meshes from the
Capture file (2.7 MB to 90 kB), and 100 `.glb` meshes plus 3 `.png` textures from the
Vectorworks one (584 kB to 43 kB). Upstream names and SHA-256 of the originals:

| file | upstream name | original SHA-256 |
|---|---|---|
| `mvr-blenderdmx-basic-fixture.mvr` | `basic_fixture.mvr` | `f78f6dcb7df1ed22c263577ae1a398e4ec3b2b2886bf2d964bd964d72e498549` (unchanged) |
| `mvr-capture-demo-show-trimmed.mvr` | `capture_demo_show.mvr` | `53b9e2baae20290362c2b40cadf65eed5d7004483c678f90aea21d67125ee3bd` |
| `mvr-vectorworks-scene-objects-trimmed.mvr` | `scene_objects.mvr` | `c1dba464dc6b6d29c3f5e5adc96a889ac82c651c462a92d7cd14c59af58d57ee` |
