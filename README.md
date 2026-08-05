# stagewash

> **AI-assisted project.** This codebase was created with [Claude Code](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. The illuminance model is calibrated rather
> than assumed: eight published photometric rows transcribed from ETC Source Four datasheets are
> held as tests, and the estimator lands within about 10% given a manufacturer's own field lumens
> and about 25% from bare lamp lumens alone. The importers are checked against real files — ETC's
> entire published Source Four bundle, 132 LM-63-02 files, parses with no failures or warnings, and
> EULUMDAT candela tables integrate back over the sphere to the lamp flux the file declares within
> 0.1%. 141 tests in total. But this is a **direct illuminance** calculation only — no
> inter-reflection, haze, shutter cuts, gobos or shadowing — and **nothing here has ever been
> checked against a light meter on a real stage.**

Model a stage and a lighting rig, focus the fixtures, and see the light levels and
coverage on the deck — before you get to the venue.

A browser app. Nothing is installed, nothing is uploaded: the whole calculation runs in
the tab.

---

## What it does

- **Build the rig.** Truss, scaff, bars and wind-up stands. Hang fixtures along a bar at
  a spacing, or place them individually.
- **Focus.** Aim a fixture at a point on the stage and it resolves the pan and tilt for
  you, or set pan/tilt directly. Zoom fixtures have a zoom; moving heads are checked
  against their pan and tilt range.
- **See the levels.** A heatmap on the stage, updated as you drag, with beam cones and
  footprints in a rotatable wireframe plot.
- **Find the problems.** Uniformity, coverage against a design level, and contiguous hot
  and dark spots listed by area with their centres.
- **Report.** A PDF with the levels, the problem areas, a full fixture schedule with
  focus and heights, and the structural loading. It carries three plots drawn from the
  same model: the heatmap in plan with a colour key, an isometric of the rig and its
  beams, and a wireframe layout by channel that shares the plan's frame, so a pool on the
  map sits over the fixture that made it. CSV of the schedule and of the raw grid.

## The two planes, which is the point

Most of the value is in a single toggle.

- **Horizontal** — illuminance on a surface parallel to the deck. The classic floor wash.
- **Vertical** — illuminance on a surface facing the audience, at head height. What a
  *face* receives.

A rig can look perfectly even on the floor and be flat and shadowless on faces, because
overhead light arrives nearly edge-on to a vertical surface and contributes almost
nothing to it. Flip between the two and the ranking of your fixtures inverts: on the
default rig the backlight contributes exactly **zero** to the face plane, and the
front-of-house units more than double. That is the calculation catching the most common
mistake in a stage rig.

## Fixture data, and how much to trust it

Every fixture carries a badge saying where its numbers came from, because a lux figure
computed from a guess is worth nothing and you have to be able to tell which is which.

- **measured** — read from a manufacturer photometric file (`.ies` / `.ldt`) that you
  imported. As good as this gets. Do this when the answer has to be right.
- **published** — the beam angle, field angle and centre-beam candela are transcribed
  from a named manufacturer datasheet; only the roll-off between those anchors is
  modelled. The built-in ETC Source Four entries are these.
- **estimated** — a generic archetype synthesised from lamp output and beam angle. Useful
  for blocking out a rig, not for promising a level. Always named `Generic`.

You can also build a custom fixture. If you have its centre-beam candela, or its lux at a
stated distance, use that — it assumes nothing. Bare lamp lumens is the weakest option
because it has to assume an optical efficiency, and real fixtures of the same class run
anywhere from 42% to 65%.

**How accurate is the estimator?** Checked against eight published photometric rows from
ETC Source Four datasheets: within about 10% when given the manufacturer's own field
lumens and angles, and within about 25% from bare lamp lumens alone. Those numbers are in
the test suite, not marketing.

**And the importer?** ETC's entire published Source Four photometric bundle — 132 real
LM-63-02 files — parses with zero failures and zero warnings. The EULUMDAT reader is
checked against real files covering every symmetry case the format defines, by
integrating each candela table over the sphere and confirming it comes back to the lamp
flux the file declares — within 0.1%, and on a LEDiL street optic it independently
recovers that luminaire's own stated 88.63% light output ratio.

Worth knowing what that exercise turned up: for four of eight fixtures ETC's own IES file
and ETC's own datasheet agree to within 1%, and for the other four they differ by 5–15%,
because the files and the sheets are different revisions. **±15% between two first-party
sources for the same fixture is the real floor on accuracy in this business** — it is
larger than anything the maths in here contributes.

## What is not modelled

This is a **direct illuminance** calculation: inverse square, the cosine law, and each
fixture's intensity distribution.

It does **not** model inter-reflection from the deck, walls or a cyc; atmospheric haze;
shutter cuts, gobos or barn doors; or shadowing by people and scenery. On a dark stage
that is the right model. In a white studio, inter-reflection can add a third again to
these figures.

Nothing here has been checked against a light meter on a real stage.

## Running it

```bash
npm install
npm run dev
```

Then open the port it prints. `npm test` runs the suite; `npm run build` produces a
static `dist/`.

<!-- attributions:start -->
This project is built on other people's work — see [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
<!-- attributions:end -->

## Licence

MIT.
