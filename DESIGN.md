# KESSLER — design spec

Companion to `KESSLER.md`. This file defines the visual system. Build against it
rather than improvising; if something here turns out to be impractical, change
this file and say what changed.

---

## 1. Direction

**Instrument, not dashboard.**

The reference world is conjunction analysis — the displays used to track orbital
debris and predict collisions. Hairline vector plots, coordinate shells, tabular
numerics, and colour that appears only when something is actually wrong.

Kessler's job on screen is to answer one question: *does a path exist from my
dependencies to this compromised package, and how deep is it.* Everything in the
UI serves that question. Nothing decorates it.

---

## 2. Non-negotiables

Break any of these and the design collapses into a generic dark security tool.

1. **Colour is data-bound.** No accent colour anywhere in the chrome — not on
   buttons, not on headings, not in the wordmark. `--breach` appears only where
   the graph reports a real path. A lockfile with no exposure renders the entire
   page in greyscale.
2. **Mono is the primary face**, not the caption face. Package names, versions,
   timestamps, depths, and counts are machine identifiers and are set as such.
3. **One motion moment.** The propagation sweep on result. Nothing else animates
   except hover state changes.
4. **Radius ≤ 2px.** Instrument surfaces are square. Circles appear only in the
   shell diagram, where they mean something.

---

## 3. Colour

```css
:root {
  --field:  #0A0D12;  /* instrument ground — blue-cast near-black */
  --shell:  #141922;  /* panels, ring fills */
  --rule:   #232B38;  /* hairlines, ring strokes, inert edges */
  --dim:    #6B7789;  /* unexposed packages, secondary text */
  --live:   #E8EDF4;  /* primary text */
  --breach: #FF4D3D;  /* compromised node and exposed paths — ONLY */
}
```

Six values. Do not add a seventh without deleting one.

**Usage rules**

| Element | Token |
|---|---|
| Page ground | `--field` |
| Panels, cards, input fills | `--shell` |
| All borders, dividers, ring strokes, unexposed edges | `--rule` |
| Labels, unexposed package nodes, metadata | `--dim` |
| Headings, values, primary text | `--live` |
| Compromised node, exposed paths, exposure count | `--breach` |

Buttons are `--shell` fill, `--rule` border, `--live` text. On hover the border
goes `--dim`. There is no primary/secondary colour distinction — hierarchy comes
from position and type, not hue.

The "clear" state uses no colour at all. When no path is found, the page simply
stays grey. That absence is the message.

---

## 4. Typography

```css
--font-display: 'Bricolage Grotesque', system-ui, sans-serif;
--font-ui:      'Geist', system-ui, sans-serif;
--font-data:    'IBM Plex Mono', ui-monospace, monospace;
```

| Role | Face | Spec |
|---|---|---|
| Display | Bricolage Grotesque 700 | `clamp(2.5rem, 6vw, 4.5rem)` / lh 0.95 / ls -0.03em |
| Section head | Bricolage Grotesque 600 | 1.5rem / lh 1.2 / ls -0.02em |
| Body | Geist 400 | 0.9375rem / lh 1.6 |
| Data | IBM Plex Mono 450 | 0.875rem / lh 1.5 / ls -0.01em / `font-variant-numeric: tabular-nums` |
| Label | IBM Plex Mono 500 | 0.6875rem / uppercase / ls 0.12em |

Display appears at most four times on the page. Body prose is the exception, not
the default — most text in this product is data.

**Always tabular figures** on anything numeric. Version numbers, depths, counts,
and timestamps must align vertically in lists.

---

## 5. Space, rule, radius

```css
--s-1: 4px;   --s-2: 8px;   --s-3: 12px;  --s-4: 16px;
--s-5: 24px;  --s-6: 32px;  --s-7: 48px;  --s-8: 64px;  --s-9: 96px;

--radius: 2px;        /* inputs, buttons */
--radius-panel: 0;    /* panels are square */
--border: 1px solid var(--rule);
```

Hairline borders everywhere. No shadows. No glows except the single centre pulse
in §7. Depth comes from `--shell` against `--field`, not from elevation effects.

---

## 6. Signature — depth shells

The hero and the product are the same object.

```
        ┌─────────────────────────────────────────┐
        │  ·  ·   ·      · ·    ·   ·   ·   ·  ·  │  shell 6 — your lockfile
        │    ╭───────────────────────────────╮    │
        │    │   ·      ·        ·      ·    │    │  shell 4
        │    │     ╭─────────────────╮       │    │
        │    │     │    ·       ·    │       │    │  shell 2
        │    │     │        ◉        │       │    │  centre — compromised
        │    │     ╰─────────────────╯       │    │
        │    ╰───────────────────────────────╯    │
        └─────────────────────────────────────────┘
```

Compromised package at centre. Direct dependencies on the outer shell. Each ring
inward is one hop. This makes HydraDB's `maxLen: 6` constraint the visual system
rather than a limitation to apologise for.

**Geometry** — SVG, `viewBox="0 0 800 800"`, centre `(400, 400)`.

| Element | Spec |
|---|---|
| Shell radii | 60, 115, 175, 240, 310, 385 (depth 1→6) |
| Shell stroke | 1px `--rule`, no fill |
| Shell label | Label style, `--dim`, at 12 o'clock outside each ring |
| Centre node | r=14, fill `--breach` |
| Package node, unexposed | r=4, fill `--dim` |
| Package node, exposed | r=5, fill `--breach` |
| Edge, unexposed | 1px `--rule` |
| Edge, exposed | 1.5px `--breach` |
| Edge shape | Quadratic bezier, control point pulled 20% toward centre |

**Angular placement is a stable hash of the package name**, not insertion order.
Same package sits at the same angle on every render. This kills layout jitter
between queries and lets someone re-run a scan and immediately see what changed.

Radial placement by depth is deterministic — no force simulation, no physics, no
settling frames. It is both easier to build and more legible than a force-directed
graph.

---

## 7. Motion

**The propagation sweep.** One orchestrated moment, on result only.

```
t=0ms      centre node pulses: scale 1 → 1.6 → 1, opacity 1 → 0, 600ms, once
t=0ms      shell 1 edges + nodes illuminate, 240ms
t=120ms    shell 2
t=240ms    shell 3
t=360ms    shell 4
t=480ms    shell 5
t=600ms    shell 6
```

Easing `cubic-bezier(0.2, 0.8, 0.2, 1)`. Total ~840ms. The animation is the
cascade — it shows the mechanism rather than decorating the reveal.

**Hover.** Hovering a path holds it at full opacity and drops every other path to
15%. 100ms linear. No scale, no glow.

**Everything else is still.** No ambient motion, no scroll parallax, no floating
particles, no skeleton shimmer. Loading states use a static `--dim` label, not a
spinner.

**Reduced motion.**

```css
@media (prefers-reduced-motion: reduce) {
  /* All shells render at final state immediately. Centre pulse omitted. */
}
```

Two reasons for the restraint: ambient motion in an incident-response readout is
noise, and a still page lets YouTube's encoder spend its bitrate on the graph
during the demo recording instead of on background movement.

---

## 8. Background layer contract

The page ground is a **slot**. Default occupant is flat `--field`. A video may
occupy it only under the terms below.

### 8.1 Zone

| Zone | Video permitted |
|---|---|
| Hero (first viewport, above the upload control) | Yes |
| Behind the shell diagram | **Never** |
| Behind panels, tables, or any data surface | **Never** |
| Footer | Yes, if it reads as a continuation of the hero |

The shell diagram uses 1px hairlines. Any moving texture behind it destroys their
legibility and there is no treatment that fixes this. This boundary is not
negotiable.

### 8.2 Treatment

Whatever occupies the slot must satisfy all four:

1. **Zero warm chroma reaching the screen.** Baked to greyscale, then tinted cold.
   `--breach` must remain the only chroma on the page or §2.1 is broken.
2. **Effective luminance ceiling ≈ `--shell` (#141922).** Nothing in the treated
   video should read brighter than a panel.
3. **Scrimmed.** Flat `rgba(10, 13, 18, 0.72)` over the video, plus a
   `linear-gradient(to bottom, transparent, var(--field))` for the bottom 40% so
   the hero dissolves into the ground rather than ending at an edge.
4. **It is then the only ambient motion on the page.** If the video is in, nothing
   else may move except §7.

### 8.3 Baking the current asset

Source: `kessier.mp4` (orig. `146301-788789707_medium.mp4`) — 1280×720, 50fps,
30.08s, 2.85 Mbps video + 189 kbps AAC, 11.4 MB, amber clockwork.

**Two corrections to the original spec, both measured 2026-08-15:**

1. **It does not loop cleanly.** First-vs-last-frame SSIM is 0.677, against a
   0.989 adjacent-frame baseline. The footage is a continuous rotation plus a
   slow camera drift, so it never returns to its start and never will. Fixed
   with a 1.5s crossfade of the tail back into the head — cheap here because the
   composition barely changes, so the blend is invisible. Costs 1.5s of duration.
2. **`brightness=-0.22` is far too dark for this source.** It floors the clip to
   YAVG 1.4/255. Composited under the §8.2 scrim that yields a hero of luma ~9.5
   against a `--field` ground of 12.7 — i.e. the hero renders as a *darker*
   rectangle than the page around it. Corrected to `brightness=0.05`.

Luminance target is a composite calculation, not a raw one. With the §8.2 scrim
the video contributes 28%: `composited = 0.72×12.7 + 0.28×V`. Aim for a
composited mean of 18–21 — above `--field` (12.7), below `--shell` (24.6).

```bash
ffmpeg -y -i kessier.mp4 -filter_complex "\
[0:v]fps=24,scale=1280:-2,setsar=1,format=yuv420p[v0];\
[v0]split[a][b];\
[a]trim=start=1.5,setpts=PTS-STARTPTS[main];\
[b]trim=start=0:end=1.5,setpts=PTS-STARTPTS[head];\
[main][head]xfade=transition=fade:duration=1.5:offset=27.08[x];\
[x]hue=s=0,colorchannelmixer=rr=0.62:gg=0.72:bb=1.0,\
eq=brightness=0.05:contrast=1.08[out]" -map "[out]" \
  -c:v libx264 -crf 31 -preset slow -pix_fmt yuv420p \
  -movflags +faststart -an web/public/kessler-field.mp4

# Poster frame, for prefers-reduced-motion and first paint
ffmpeg -y -i web/public/kessler-field.mp4 -frames:v 1 -q:v 4 web/public/kessler-field.jpg
```

`xfade` offset = (duration − 1.5) − 1.5. `hue=s=0` strips saturation;
`colorchannelmixer` re-tints cold; `eq` sets the level.

**Shipped result:** 2.48 MB (−78%), 28.58s, 24fps, no audio track, faststart.
Composited luma 19.4 mean / 21.2 peak — inside the band. Loop-seam SSIM 0.873
against an adjacent-frame baseline of 0.851 in the same encode, i.e. the join is
indistinguishable from ordinary motion.

Verification commands worth re-running if the asset is ever re-cut:

```bash
# luminance — compare against the composite band above
ffmpeg -v error -i web/public/kessler-field.mp4 \
  -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -

# loop seam — must be >= the adjacent-frame control in the same encode
ffmpeg -v error -i first.png -i last.png -lavfi "[0][1]ssim=stats_file=-" -f null -
```

### 8.4 Markup

```html
<div class="field">
  <video class="field__video" src="/kessler-field.mp4"
         poster="/kessler-field.jpg"
         autoplay muted loop playsinline preload="metadata"></video>
  <div class="field__scrim"></div>
</div>
```

```css
.field { position: absolute; inset: 0 0 auto 0; height: 78vh; overflow: hidden; }
.field__video { width: 100%; height: 100%; object-fit: cover; }
.field__scrim {
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, transparent 60%, var(--field) 100%),
    rgba(10, 13, 18, 0.72);
}
@media (prefers-reduced-motion: reduce) { .field__video { display: none; } }
```

The reduced-motion rule falls through to the poster via the container background —
set `.field { background: url(/kessler-field.jpg) center/cover; }`.

If re-encoding is skipped, the runtime fallback is
`filter: grayscale(1) brightness(0.38) contrast(1.12)` on `.field__video`. Bake it
instead where possible; per-frame video filters are GPU-expensive and can jank on
lower-end machines, including whatever the judges are watching on.

### 8.5 The honest tradeoff

At this treatment the gears stop reading as gears. They read as slow rotating
machinery texture at the edge of perception — which is what a background should
be, and which works.

Note the correction in §8.3: "edge of perception" has a floor as well as a
ceiling. Pushed too dark the video does not become subtle, it becomes a dark
patch that is *more* conspicuous than texture, because it breaks the flatness of
`--field`. The band is narrow and it is bounded on both sides.

**Legibility of the footage and integrity of the palette are mutually exclusive
here.** Amber gears at recognisable brightness would take the severity colour and
put a coupled-machinery metaphor behind a product about coupling being a
liability. The spec chooses the palette. If the footage needs to be recognisable,
that is a different design and this file no longer applies.

**Disable the video while screen-recording anything past the title card.** It
competes for encoder bitrate with the graph.

---

## 9. Components

**Upload control** — the primary action, so it gets the most space in the hero.
Dashed 1px `--rule` border, `--shell` fill, `--radius`. Drag-over state: border
goes `--dim`. No colour change, no scale.

**Package input** — mono, `--shell` fill, 1px `--rule`, 2px radius. Placeholder in
`--dim`: `lodash@4.17.21`.

**Result panel** — square, `--shell`, 1px `--rule`, `--s-5` padding. Header is a
Label; body is Data.

**Path list** — one row per exposed path, mono, tabular. Format:

```
react-scripts@5.0.1  →  webpack@5.88.0  →  ⋯  →  lodash@4.17.21     depth 4
```

Hovering a row highlights the corresponding arc in the diagram, and vice versa.
Bidirectional highlight is the one interaction worth building carefully — it is
what makes the diagram legible rather than decorative.

**Tables** — hairline `--rule` rows, no zebra striping, no vertical borders.
Column headers in Label style.

---

## 10. Copy

Plain, active, specific. The interface does not sell and does not apologise.

| State | Copy |
|---|---|
| Empty | `Drop a package-lock.json to map exposure.` |
| Scanning | `Traversing 6 shells.` |
| Exposed | `14 of 212 packages reach lodash@4.17.21.` |
| Clear | `No path found within 6 hops.` |
| Bound disclosure | `Graph covers 8,400 packages. Paths bounded at depth 6. Dev dependencies excluded.` |
| Error, no such package | `lodahs@4.17.21 is not in the graph. Check the name.` |

That bound-disclosure line belongs on the page, not buried in the README. Stating
the limits plainly reads as rigour, and judges who know npm will look for it.

---

## 11. Quality floor

- Responsive to 375px. Below 900px the shell diagram drops to 4 shells with a
  note, or falls back to the path list alone.
- Visible keyboard focus: 2px `--live` outline, 2px offset. Never removed.
- `prefers-reduced-motion` respected throughout.
- Text contrast: `--live` on `--field` and `--dim` on `--field` both clear AA.
- Video is decorative — `aria-hidden="true"`, no captions needed, never carries
  information.

---

## 12. Do not

- Add a second accent colour, or use `--breach` for anything but real exposure
- Set package names or versions in a proportional face
- Add ambient motion beyond §8
- Use a spinner, skeleton shimmer, or progress bar
- Round anything past 2px
- Add gradients to text, buttons, or panels
- Place the video behind the shell diagram or any data surface
- Introduce a logo mark that uses colour
