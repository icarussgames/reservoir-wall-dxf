# Reservoir Wall DXF

A small web page that turns a reservoir wall (embankment) definition into a **DXF file for Civil 3D / AutoCAD**.

You give it two UTM points for the wall axis, plus crest and slope data for each material shell. It draws the crest edges and toe lines as **2D polylines, each at one constant elevation**. You check them in a plan preview, then download a DXF.

**Live app:** https://icarussgames.github.io/reservoir-wall-dxf/

Nothing to install. It runs entirely in your browser and never uploads your data anywhere.

---

## Quick start (2 minutes)

1. Open the live app (link above). It starts with a default wall: an axis and one shell called **`outer shell`**, already drawn.
2. In **Wall axis** (top right), type your **Leftmost** and **Rightmost** axis points (UTM Easting / Northing).
   *Leftmost/rightmost are as seen **from upstream**, i.e. standing in the lake looking at the wall.*
3. In **Shell Quick Mode**, set the crest elevation, the two crest distances, and the slopes/toe elevations. Then press **Generate this shell**.
4. Press **Export DXF** and open the file in Civil 3D.
5. Press **Export JSON** to save your work, and **Import JSON** to load it again later.

An example project is in [`examples/sample-project.json`](examples/sample-project.json). Download it and load it with **Import JSON**.

---

## How Quick Mode works

The screen has three columns:

| Left: **Shells** | Middle: **Plan preview + polylines** | Right: **Wall axis + Quick Mode** |
|---|---|---|
| One entry per material shell = one CAD layer (`outer shell`, `core`, `filter`, …) | Plan view of all shells (dashed line = axis). Below it, the polylines of the selected shell, with an editable vertex table | The shared axis, then the Quick Mode values of the **selected** shell |

### The axis (shared)

Entered **once** and used by every shell: Leftmost → Rightmost, as seen from the lake.

- **Upstream / aguas arriba** is the **lake** side.
- **Downstream / aguas abajo** is the **dry** side.

The preview shows this legend in its top-left corner.

If you move the axis, lines that already exist don't move. Press **Generate this shell** again, or **Regenerate all shells from axis**.

### Per-shell values

Click a shell on the left and its own values appear on the right:

| Field | Meaning |
|---|---|
| Crest elev Z_crest | Elevation of both crest edges |
| **US crest distance d_US** | Distance from the axis to the upstream crest edge. **Positive = toward the lake.** Negative is allowed (the edge is then on the dry side of the axis) |
| **DS crest distance d_DS** | Distance from the axis to the downstream crest edge. **Positive = toward the dry side.** Negative is allowed |
| Width W + *Symmetric from W* | Shortcut only: sets d_US = d_DS = W/2 |
| Include upstream / downstream | Untick one to make a one-sided shell (e.g. only an upstream face) |
| H : V | Slope of that face, horizontal : vertical (e.g. 2 : 1) |
| Toe elev (or ΔZ drop) | Elevation of the toe line, or a drop below the crest |

**Generate this shell** replaces **only that shell's** lines. It asks first if the shell already has lines. Other shells are not touched.

Each generated shell has 4 lines: *Crest US edge (lake)*, *US toe*, *Crest DS edge (dry)* and *DS toe*.

### Adding a shell (e.g. a core)

Click **+ Add shell** and give it a name (e.g. `core`). It starts as a **copy of the selected shell's values**. Change what differs (for a core, e.g. d_US = 2, d_DS = −1, steeper slopes) and press **Generate this shell**.

### Warnings vs. errors

- **Warnings** (yellow) never stop you. Examples: the crest width comes out negative, a toe is above the crest, or a shell has no lines yet.
- **Errors** (red) only block *Export DXF*. Examples: an empty name, or a non-numeric elevation or coordinate.

### Manual editing

After generating, you can still click any polyline and edit its name, elevation or vertices by hand. You can also add polylines with **+ Add polyline**. Pressing *Generate this shell* again overwrites those edits for that shell.

The **Advanced** tab has an older free-form tool: it offsets any multi-point baseline by |ΔZ|·H/V.

---

## Bringing the DXF into Civil 3D

What's in the file:

- DXF **R2000** (ASCII). Units = **meters**. Coordinates are your UTM values as typed.
- **One layer per shell**, named exactly as in the app (spaces kept, e.g. `outer shell`), plus the standard layer `0`.
- Only **LWPOLYLINE** entities (2D polylines). Each has a single **Elevation** property: DXF code 38, the value you see as "Z" in the app. There are no 3D polylines and no per-vertex Z.

To bring it in:

1. **Open directly:** *Open → Files of type: DXF* and pick the file. Or, to add it to an existing drawing, use the `INSERT` command (or `DXFIN` / attach as an Xref).
2. Check the geometry: select a line and look at *Properties → Geometry → Elevation*. It should show the crest or toe elevation.
3. **Coordinate system:** DXF files carry no coordinate-system info. If you need one, set your UTM zone in Civil 3D's *Drawing Settings* (e.g. WGS84 / UTM 19S). The numbers are already in UTM meters.
4. **Surfaces:** 2D polylines with an elevation can be added to a TIN surface as **Contours** or **Breaklines**. You can also convert them with *Create Feature Lines from Objects*, which picks up the elevation. Check the result in a section view.
5. Polyline names (e.g. "US toe") are kept in the JSON only. DXF polylines have no name field. The **layer** tells you the shell, and the **elevation** tells you crest or toe.

---

## More documentation

| Document | For |
|---|---|
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | Exact geometry and sign rules (read this before changing any formula) |
| [docs/HISTORY.md](docs/HISTORY.md) | How the app evolved and why decisions were made |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Files, code structure, data format, running locally, testing, deployment |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Continuing from another account, repo ownership, prompt for a new AI assistant, ideas for later |

## Files in this repo

```
index.html          the page (layout and fields)
app.js              all logic: geometry, DXF writer, UI
styles.css          look & feel
smoke_test.py       automatic check of geometry + DXF (python3 smoke_test.py)
examples/           sample DXFs and a sample JSON project (written by the smoke test)
docs/               documentation
.nojekyll           tells GitHub Pages to serve files as-is
```
