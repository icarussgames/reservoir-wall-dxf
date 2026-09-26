# History and design decisions

All times are Chile time (UTC−3). The commit hashes are in this repo (`git log`). The steps before the first commit were built in a scratch folder and are summarised from the assistant's notes.

## Timeline

### 1. Static web UI (24 Sep 2026, morning, before git)
- A single page: plain HTML + JavaScript + CSS. No build step and no libraries, so it can be opened from GitHub Pages or straight from a file.
- **Groups** of polylines (later called *shells*), each exported as a DXF layer. Each polyline has a **single elevation**, with vertices entered by hand or generated.
- **Inclination helper** (today's *Advanced* tab): offsets a multi-point baseline by |Z − Z₀|·(H/V).
- A home-made **DXF writer** (R2000, `LWPOLYLINE` + code 38), a plan preview, JSON save/load, and a demo "Reservoir Wall A".
- *Why:* the user wanted 2D polylines at a constant elevation for Civil 3D, not 3D polylines. Writing the DXF by hand avoids any heavy dependency and gives full control over group codes.

### 2. Quick Mode: two points and ±W/2 (24 Sep, morning)
- A fast path: two UTM points define the crest axis. Crest borders are at ±W/2 (exact parallel offset, like AutoCAD OFFSET), and toes are further out by |ΔZ|·H/V.
- The inputs were renamed to **Leftmost / Rightmost as seen from upstream**, so the side convention is tied to something physical an engineer can picture.
- An optional "Core distribution" section generated a core layer.
- *Why:* the user couldn't test in CAD yet and needed something quick to try.

### 3. Published on GitHub Pages, no password — `a2b9954` (24 Sep 09:05)
- The repo `icarussgames/reservoir-wall-dxf` is public, and Pages serves the `master` branch root. `.nojekyll` makes GitHub serve the files as they are.
- *Why no password:* GitHub Pages can't password-protect a site on normal plans. The app has no server and stores nothing, since all work stays in the user's browser, so there's nothing sensitive to protect. Anyone with the link can open it.

### 4. Upstream/downstream sign fix — `1f6887b` (24 Sep 09:43)
- The first version put the lake on the **left** of leftmost→rightmost (+n). User testing showed the sides were **flipped**.
- Fixed: **upstream/lake = −n, downstream/dry = +n**, with `n = (−d.y, d.x)` and `d = normalize(R − L)`. The reasoning is in [CONVENTIONS.md](CONVENTIONS.md#1-axis-and-sides).
- *Lesson:* sign conventions must be written down and tested. The smoke test now checks the sign of every offset.

### 5. Layers are material shells: `outer shell` — `90b724c`, `4388275` (24 Sep 09:46)
- Before this, layers followed geometric roles: `Crest`, `Upstream`, `Downstream`, `Core`, and the crest edges were drawn twice.
- Now **one layer = one material zone (shell)**. The whole outer envelope (both crest edges and both toes) goes on the layer **`outer shell`**, and the core on `core`.
- Layer names keep spaces, so the DXF layer is literally `outer shell` (`4388275`).
- *Why:* in CAD the user organises by material. Duplicated lines caused confusion.

### 6. Per-shell Quick Mode, shared axis, signed distances — `90e1fb9` (24 Sep 21:22)
- User requests: *"Make the quick mode appear for each layer/shell created… we just reuse the axis points"* and *"for some shells the crest distance to US and DS is different, maybe one of them even negative."*
- The **axis** is entered once and stored as `project.axis`. **Each shell** has its own Quick Mode values in `group.quick`.
- The **signed** crest distances `d_US` (+ = lake) and `d_DS` (+ = dry) replace W/2. "Symmetric from W" remains only as a shortcut.
- Include-upstream/downstream toggles allow one-sided shells. A negative crest width warns but doesn't block.
- **+ Add shell** copies the selected shell's values. The old "Core distribution" section was removed, because a core is now just another shell.
- **Generate this shell** rebuilds only that shell. Old JSON files still import.
- *Why:* each material zone has its own geometry, and the user can build shells one by one without the app needing to "know" dam design rules.

### 7. Handoff packaging (26 Sep 2026)
- Added the docs, the smoke test at the repo root, and the example DXFs and JSON in `examples/`, so the repo is self-contained and can be continued from another account.

## Key decisions at a glance

| Decision | Reason |
|---|---|
| 2D `LWPOLYLINE` + code 38, never 3D / code 30 | The user needs polylines at a constant elevation for Civil 3D (contours/breaklines), not 3D polylines |
| Plain HTML/JS, no build, no libraries | Easy for a non-web-developer to host, open and edit. Works offline |
| Home-made DXF writer | Tiny, and full control over group codes |
| Axis L→R seen from the lake, lake = −n | Physical and unambiguous. Corrected after testing |
| Signed per-side crest distances | Real shells aren't symmetric about the axis, and some sit entirely on one side |
| Layers = material shells | Matches how the user works in CAD |
| Warnings don't block | The engineer decides. The tool only points things out |
| Generate replaces only that shell | Lets you work on shells one at a time without losing the others |
