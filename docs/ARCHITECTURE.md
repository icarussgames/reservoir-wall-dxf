# Architecture and developer guide

Written for someone who is **not** a web developer. The whole app is three text files and has no build step.

## Files

```
index.html            page layout: header buttons, shell list, preview, axis panel, Quick Mode form, Advanced tab
app.js                all logic (about 1,300 lines, plain JavaScript)
styles.css            colours and layout (dark theme)
smoke_test.py         automatic test: runs app.js with Node and checks the DXF output
examples/
  sample-project.json   axis + "outer shell" + "core"; load it with "Import JSON"
  sample-quick.dxf      DXF of that project
  sample-out.dxf        DXF of the old free-form "advanced" sample
docs/                 these documents
.nojekyll             empty file; tells GitHub Pages not to process the site with Jekyll
.gitignore            keeps junk files (e.g. __pycache__) out of git
```

## How app.js is organised

Everything sits inside one `(() => { ... })()` wrapper, in two halves.

**1. Pure logic (no web page needed).** This half is what the smoke test runs.

| Function | What it does |
|---|---|
| `axisFrame(L, R)` | Returns `d` (unit axis direction) and `n = (−d.y, d.x)` |
| `offsetSegment(a, b, n, s)` | Shifts the segment a–b sideways by signed distance `s` along `n` |
| `planOffsetDistance(z0, z, HV)` | `|z − z0| · HV`, the horizontal run of a slope |
| **`buildShellPolylines(axis, quick)`** | **Core of Quick Mode.** Builds the 4 lines of one shell (or 2 if one side is off). Returns `{ polylines, warnings, hint, offsets }` and throws an error for invalid input |
| `defaultQuick()` | Default shell values (Z_crest 523, d_US = d_DS = 3.5, US 2:1 to 423, DS 1:1 to 473) |
| `defaultProject()` | Default axis + `outer shell`, already generated |
| `normalizeProject(json)` | Cleans up imported JSON, including old formats |
| **`exportDxf(project)`** | **Writes the DXF text**: header, layer table, one `LWPOLYLINE` per polyline |
| `validateProject(project)` | Lists errors and warnings |
| `sanitizeLayerName(name)` | Makes a name safe for DXF while keeping spaces |
| `offsetPolylineFromBaseline(...)` | Advanced tab: per-vertex offset of a multi-point line |

At the end of this half, if there is no web page (Node.js), it exports these functions and stops. That's how `smoke_test.py` can call the real code.

**2. User interface.** This half renders the shell list (`renderGroups`), polylines (`renderPolys`, `renderPolyDetail`), the Quick Mode form (`renderQuickPanel`, `onQuickFieldInput`) and the SVG plan preview (`renderPreview`). Actions: `onGenerateShell`, `onRegenerateAll`, `addShell`, `doExportDxf`, `doExportJson`, `doImportJson`. `bind()` connects the buttons.

In the browser console, `window.ReservoirWallApp` gives access to the functions plus `getProject()` and `setProject()`.

**Where to change what:**
- A formula or sign → `buildShellPolylines` (and update `docs/CONVENTIONS.md` and `smoke_test.py`).
- A new Quick Mode field → add the input in `index.html`, add it to `QM_FIELDS` and `defaultQuick()` in `app.js`, then use it in `buildShellPolylines`.
- DXF content → `exportDxf`.

## Data model (the JSON file)

```jsonc
{
  "name": "Sample reservoir wall",
  "units": "meters (UTM)",
  "axis": {                                   // shared by all shells
    "leftmost":  { "x": 350000, "y": 6300000 },   // x = Easting, y = Northing
    "rightmost": { "x": 350200, "y": 6300010 }
  },
  "groups": [                                 // one entry per shell = CAD layer
    {
      "id": "g_outer", "name": "outer shell",
      "color": "#3b9eff", "dxfColor": 5,      // preview colour / AutoCAD colour index
      "quick": {                              // this shell's Quick Mode values
        "zCrest": 523, "dUs": 3.5, "dDs": 3.5, "symW": 7,
        "includeUs": true, "usH": 2, "usV": 1, "usZToe": 423, "usUseDz": false, "usDz": 100,
        "includeDs": true, "dsH": 1, "dsV": 1, "dsZToe": 473, "dsUseDz": false, "dsDz": 50
      },
      "polylines": [
        { "id": "p_outer_1", "name": "Crest US edge (lake)", "elevation": 523,
          "closed": false, "source": "quick",   // "quick" = made by Generate; absent = manual
          "vertices": [ { "x": 350000.17, "y": 6299996.50 }, { "x": 350200.17, "y": 6300006.50 } ] }
      ]
    }
  ]
}
```

A full example is in `examples/sample-project.json`. Older files may have `quickAxis` instead of `axis` and no `quick`. They still load.

## Run it on your computer

Option A: double-click `index.html`. It opens in your browser and works offline.

Option B, a local web server (closest to the live site):

```bash
cd reservoir-wall-dxf          # the folder with index.html
python3 -m http.server 8765    # on Windows: py -m http.server 8765
```

Then open http://127.0.0.1:8765/ and stop the server with Ctrl+C. After editing a file, reload the page (Ctrl+F5 to be sure).

## Run the smoke test

You need **Python 3.8+** and **Node.js 18+** (https://nodejs.org).

```bash
python3 smoke_test.py
```

It builds a project with `outer shell` (3.5 / 3.5) and `core` (d_US = 2, d_DS = −1), exports it with the real `exportDxf`, and parses the DXF in Python. It checks:

- the layer names are exactly `outer shell` and `core`
- every line is an `LWPOLYLINE` with code 38, with no code 30 and no 3D polylines
- every offset and elevation is exact, and the core DS crest edge is on the lake side
- the warnings, one-sided shells, old-JSON import and JSON round trip all behave

It ends with `All smoke tests passed.` and rewrites the three files in `examples/`. If you change the geometry on purpose, update the expected numbers in the test.

## Deployment (GitHub Pages)

- Pages is set to **Deploy from a branch: `master`, folder `/` (root)**. Every push to `master` republishes the site at https://icarussgames.github.io/reservoir-wall-dxf/, usually within about a minute.
- `.nojekyll` must stay, so GitHub serves the files as they are.
- The easiest way to edit without installing anything: open a file on github.com, click the pencil (Edit) icon, change it, and **Commit changes** to `master`. The site updates by itself.
- To check the build: repo → **Actions** tab (or **Settings → Pages**). From a terminal with the GitHub CLI: `gh api repos/icarussgames/reservoir-wall-dxf/pages --jq .status`, which should print `built`.
- If the page looks old after an update, force-reload (Ctrl+F5). The browser may be caching the old files.
