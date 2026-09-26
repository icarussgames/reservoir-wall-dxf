# Handoff: continuing from a new account

Everything needed to continue is in this repository: code, tests, examples and docs. Nothing depends on the previous assistant's workspace. (The scratch copy it used is not needed; this repo is the source of truth.)

## 1. Get a copy

- **Just use it:** https://icarussgames.github.io/reservoir-wall-dxf/
- **Download the files:** on github.com, open the repo and click **Code → Download ZIP**. Or, with git installed: `git clone https://github.com/icarussgames/reservoir-wall-dxf.git`
- **Check it works:** `python3 smoke_test.py` should end with `All smoke tests passed.` (needs Python and Node.js; see [ARCHITECTURE.md](ARCHITECTURE.md)).

## 2. Repository ownership: pick one

The repo belongs to the GitHub account **`icarussgames`**. Whoever holds that account's login has admin rights over it. The previous assistant's workspace was logged in as `icarussgames`; that login does **not** move with you, so your new account needs its own access. Three options:

| Option | How | Live URL | Good when |
|---|---|---|---|
| **A. Keep it, add a collaborator** | Signed in as `icarussgames`: repo → **Settings → Collaborators → Add people** → enter the new GitHub username. The new account accepts the email invitation and can then push | **Unchanged**: `icarussgames.github.io/reservoir-wall-dxf` | You want the link people already have to keep working |
| **B. Transfer the repo** | Signed in as `icarussgames`: **Settings → General → Danger Zone → Transfer ownership** → new owner. The new owner accepts | **Changes** to `https://<new-owner>.github.io/reservoir-wall-dxf/`. The old Pages link stops working (GitHub redirects the repo and git URLs, but **not** the Pages site). Afterwards, check **Settings → Pages**: deploy from branch `master`, folder `/` | You want the new account to fully own it |
| **C. Make your own copy** | From the new account: **Fork**, or create a new repo and upload the files. Then **Settings → Pages → Deploy from a branch → `master` / root** | New URL under the new account | You want a clean, independent start |

With B or C, update the live URL in `README.md` and in the docs.

## 3. Prompt for a new AI assistant

Copy everything in the box below into a new chat, together with the repo link or the files.

```text
I'm a civil engineer (not a web developer). I have a small static web app, "Reservoir Wall DXF",
repo https://github.com/icarussgames/reservoir-wall-dxf, live at
https://icarussgames.github.io/reservoir-wall-dxf/ (GitHub Pages, deploy from branch master, root,
with .nojekyll). Plain HTML/JS/CSS: index.html, app.js, styles.css. No build step, no libraries.
It generates DXF files for Civil 3D for reservoir walls (embankments).

Read README.md and docs/CONVENTIONS.md first. Key rules, which are NOT to be changed without asking me:
- Output is ONLY 2D LWPOLYLINE entities, each with ONE elevation in DXF group code 38.
  Never 3D polylines, never group code 30 (per-vertex Z). DXF R2000 (AC1015), $INSUNITS=6 (meters).
- Axis: two UTM points, Leftmost L and Rightmost R, as seen from upstream (standing in the lake).
  d = normalize(R - L), n = (-d.y, d.x). Upstream / aguas arriba / lake = -n. Downstream / aguas abajo / dry = +n.
  (An early version had this flipped; it was fixed after testing.)
- The axis is shared by all shells (project.axis). Each shell (= one CAD layer = one material zone)
  has its own Quick Mode values (group.quick): Z_crest; signed crest distances d_US (+ = toward the lake)
  and d_DS (+ = toward the dry side), negatives allowed; US/DS slope H:V; US/DS toe elevation (or ΔZ drop);
  include-upstream/include-downstream toggles.
- Lines are exact parallel offsets of the axis by a signed distance s along n:
  US crest edge s = -d_US (Z_crest); US toe s = -(d_US + |Z_crest - Z_toe_US| * H/V_US) (Z_toe_US);
  DS crest edge s = +d_DS (Z_crest); DS toe s = +(d_DS + |Z_crest - Z_toe_DS| * H/V_DS) (Z_toe_DS).
- The outer envelope goes on a layer named exactly "outer shell" (spaces kept). Other materials get their
  own shells/layers, e.g. "core". "+ Add shell" copies the selected shell's values.
  "Generate this shell" replaces only that shell's lines (after a confirmation).
  Warnings (e.g. negative crest width) never block anything.
- Key code: buildShellPolylines(axis, quick) and exportDxf(project) in app.js. app.js exports its pure
  functions when run under Node, and smoke_test.py (python3 smoke_test.py, needs Node) uses them to check
  layers, code 38, no code 30, and exact signed offsets. Run it after every change, and update
  docs/CONVENTIONS.md if a rule changes.
- Explain things in plain language, and tell me exactly what to click or run.

What I want to do next: <describe the change here>
```

## 4. Ideas for later

**Geometry**
- **Berms / benches:** a list per side of (elevation, berm width), giving broken slopes: crest → slope → berm → slope → toe. Each berm edge would be another constant-elevation line.
- Different H:V above and below each berm.
- **Curved or multi-point axis:** today the axis is one straight segment. A polyline axis needs real offsets with mitred or filleted corners. The Advanced tab already has a simple per-vertex version.
- Toe from terrain: find where the slope meets an existing ground surface (would need ground data).
- Closed outlines per shell (crest edges joined to toes at the ends), for hatching or areas.
- Wall ends and abutments: how the lines should finish at the valley sides.

**Shells and workflow**
- More shells with templates (filter, drain, riprap, transition zones).
- Duplicate or reorder shells with their values. Mirror a shell's values US↔DS.
- Import axis points from CSV. A Spanish UI option.
- A cross-section view (perpendicular to the axis) to check the shells visually.

**Civil 3D import quirks to check in real use**
- Assign the drawing's coordinate system (UTM zone). The DXF has none.
- Surfaces from 2D polylines with elevation: test *Contours* vs *Breaklines* vs *Feature Lines from Objects*, and check weeding and supplementing settings.
- Layer names with spaces are valid in AutoCAD/Civil 3D. Confirm company CAD standards don't require otherwise.
- Line names (e.g. "US toe") are not in the DXF. If needed, add text labels or XDATA.
- Very large UTM coordinates are fine in DXF, but check that the drawing isn't zoomed far away from them after import (use `ZOOM` → `Extents`).
