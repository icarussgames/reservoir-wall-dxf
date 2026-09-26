#!/usr/bin/env python3
"""
Smoke test for the per-shell Quick Mode.

Run from the repo root:   python3 smoke_test.py      (needs Python 3.8+ and Node.js 18+)
It also (re)writes the example files in examples/:
  examples/sample-quick.dxf     axis + "outer shell" + "core" (Quick Mode)
  examples/sample-out.dxf       the older free-form "advanced" sample
  examples/sample-project.json  the same Quick Mode project, loadable with "Import JSON"

Runs the REAL app.js geometry + DXF exporter through node (app.js exports its pure
functions when no DOM is present), writes sample DXFs, then independently parses the
DXF in Python and checks layers, LWPOLYLINE/38, absence of code 30, and signed offsets.

Convention: d = normalize(rightmost - leftmost), n = (-d.y, d.x);
upstream (lake) = -n, downstream (dry) = +n.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys

DIR = os.path.dirname(os.path.abspath(__file__))   # repo root (works from any cwd)
APP = os.path.join(DIR, "app.js")
EXAMPLES = os.path.join(DIR, "examples")
OUT_QUICK = os.path.join(EXAMPLES, "sample-quick.dxf")
OUT_ADV = os.path.join(EXAMPLES, "sample-out.dxf")
OUT_JSON = os.path.join(EXAMPLES, "sample-project.json")

LEFT = (350000.0, 6300000.0)
RIGHT = (350200.0, 6300010.0)
Z_CREST = 523.0

NODE_SCRIPT = r"""
const app = require(process.argv[1]);
const axis = { leftmost: { x: 350000, y: 6300000 }, rightmost: { x: 350200, y: 6300010 } };
const outerQ = { ...app.defaultQuick(), zCrest: 523, dUs: 3.5, dDs: 3.5,
                 usH: 2, usV: 1, usZToe: 423, dsH: 1, dsV: 1, dsZToe: 473 };
const coreQ  = { ...app.defaultQuick(), zCrest: 523, dUs: 2, dDs: -1,
                 usH: 0.3, usV: 1, usZToe: 423, dsH: 0.3, dsV: 1, dsZToe: 473 };
const outer = app.makeGroup("outer shell", 0, [], outerQ);
const core  = app.makeGroup("core", 1, [], coreQ);
const rOuter = app.buildShellPolylines(axis, outerQ);
const rCore  = app.buildShellPolylines(axis, coreQ);
outer.polylines = rOuter.polylines;
core.polylines  = rCore.polylines;
const project = { name: "Sample reservoir wall", units: "meters (UTM)", axis, groups: [outer, core] };
// Stable ids so examples/sample-project.json does not change on every run
[["outer", outer], ["core", core]].forEach(([k, g]) => {
  g.id = "g_" + k;
  g.polylines.forEach((pl, i) => { pl.id = `p_${k}_${i + 1}`; });
});

// Warning check: negative crest width must warn, not throw
const rNeg = app.buildShellPolylines(axis, { ...coreQ, dUs: -3, dDs: 1 });
// One-sided shell
const rUsOnly = app.buildShellPolylines(axis, { ...outerQ, includeDs: false });
// Old-format JSON import must not crash
const legacy = app.normalizeProject({
  name: "old", quickAxis: { p0: { x: 1, y: 2 }, p1: { x: 3, y: 4 } },
  groups: [{ name: "outer shell", polylines: [{ name: "x", elevation: 5, vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] },
           { name: "empty" }],
});
// Default project generated on load
const def = app.defaultProject();

process.stdout.write(JSON.stringify({
  dxf: app.exportDxf(project),
  projectJson: JSON.stringify(project, null, 2),
  reimported: app.normalizeProject(JSON.parse(JSON.stringify(project))).groups.map(g => [g.name, g.polylines.length, !!g.quick]),
  advDxf: app.exportDxf(app.sampleProject()),
  outerOffsets: rOuter.offsets, coreOffsets: rCore.offsets,
  outerWarnings: rOuter.warnings, coreWarnings: rCore.warnings,
  negWarnings: rNeg.warnings,
  usOnlyNames: rUsOnly.polylines.map(p => p.name),
  legacy: { axis: legacy.axis, groups: legacy.groups.map(g => [g.name, g.polylines.length]) },
  def: { axis: def.axis, groups: def.groups.map(g => [g.name, g.polylines.length]), quick: def.groups[0].quick },
  jsonRoundTrip: JSON.parse(JSON.stringify(project)).groups.map(g => [g.name, !!g.quick, g.quick && g.quick.dDs]),
}));
"""


def parse_dxf(text: str):
    lines = text.split("\n")
    pairs = [(lines[i].strip(), lines[i + 1]) for i in range(0, len(lines) - 1, 2)]
    layers, ents, cur, section = [], [], None, None
    prev_code_is_2_after_layer = False
    for idx, (code, val) in enumerate(pairs):
        if code == "0" and val == "SECTION":
            section = pairs[idx + 1][1]
            continue
        if section == "TABLES" and code == "0" and val == "LAYER":
            prev_code_is_2_after_layer = True
            continue
        if prev_code_is_2_after_layer and code == "2":
            layers.append(val)
            prev_code_is_2_after_layer = False
        if section == "ENTITIES":
            if code == "0":
                if cur:
                    ents.append(cur)
                if val == "ENDSEC":
                    cur, section = None, None
                    continue
                cur = {"type": val, "codes": [], "verts": []}
            elif cur is not None:
                cur["codes"].append(code)
                if code == "8":
                    cur["layer"] = val
                elif code == "38":
                    cur["elev"] = float(val)
                elif code == "10":
                    cur["verts"].append([float(val), None])
                elif code == "20":
                    cur["verts"][-1][1] = float(val)
    return layers, ents


def signed_offset(pt):
    dx, dy = RIGHT[0] - LEFT[0], RIGHT[1] - LEFT[1]
    ln = math.hypot(dx, dy)
    n = (-dy / ln, dx / ln)
    return (pt[0] - LEFT[0]) * n[0] + (pt[1] - LEFT[1]) * n[1]


def check(cond, msg):
    if not cond:
        print("FAIL:", msg)
        sys.exit(1)
    print("  ok -", msg)


def main():
    try:
        res = subprocess.run(["node", "-e", NODE_SCRIPT, APP], capture_output=True, text=True)
    except FileNotFoundError:
        print("FAIL: Node.js is not installed (needed to run app.js). Install it from https://nodejs.org")
        sys.exit(1)
    if res.returncode != 0:
        print(res.stderr)
        sys.exit(1)
    r = json.loads(res.stdout)

    os.makedirs(EXAMPLES, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        f.write(r["projectJson"] + "\n")
    with open(OUT_QUICK, "w", encoding="utf-8", newline="\n") as f:
        f.write(r["dxf"])
    with open(OUT_ADV, "w", encoding="utf-8", newline="\n") as f:
        f.write(r["advDxf"])

    dxf = r["dxf"]
    layers, ents = parse_dxf(dxf)
    user_layers = [l for l in layers if l != "0"]
    print(f"Quick DXF: {OUT_QUICK}")
    check(user_layers == ["outer shell", "core"], f"layers exactly ['outer shell', 'core'] (got {user_layers})")
    lw = [e for e in ents if e["type"] == "LWPOLYLINE"]
    check(len(lw) == 8 and len(lw) == len(ents), f"8 entities, all LWPOLYLINE (got {len(lw)}/{len(ents)})")
    check(all("38" in e["codes"] for e in lw), "every LWPOLYLINE has group code 38")
    check(all("30" not in e["codes"] for e in lw) and "\n30\n" not in dxf, "no group code 30 anywhere")
    check("POLYLINE\n" not in dxf.replace("LWPOLYLINE\n", ""), "no old-style/3D POLYLINE entities")
    check(dxf.rstrip().endswith("EOF"), "file ends with EOF")

    def offsets_on(layer):
        out = []
        for e in lw:
            if e["layer"] == layer:
                s = [signed_offset(v) for v in e["verts"]]
                check(abs(s[0] - s[1]) < 1e-6, f"{layer} line Z={e['elev']} is parallel to axis (s={s[0]:.4f})")
                out.append((round(s[0], 4), e["elev"]))
        return out

    outer = offsets_on("outer shell")
    core = offsets_on("core")
    # outer: US crest -3.5, US toe -(3.5+100*2)=-203.5, DS crest +3.5, DS toe +(3.5+50*1)=+53.5
    check(outer == [(-3.5, 523.0), (-203.5, 423.0), (3.5, 523.0), (53.5, 473.0)],
          f"outer shell offsets/elevs (got {outer})")
    # core: US crest -2, US toe -(2+30)=-32, DS crest +(-1)=-1, DS toe -1+15=14
    check(core == [(-2.0, 523.0), (-32.0, 423.0), (-1.0, 523.0), (14.0, 473.0)],
          f"core offsets/elevs (got {core})")
    core_ds_crest = core[2][0]
    check(core_ds_crest < 0, f"core DS crest edge is on the LAKE side of the axis (s={core_ds_crest} < 0, lake = -n)")
    check(r["coreOffsets"]["dsCrest"] == -1 and r["outerOffsets"]["usCrest"] == -3.5, "offsets reported by app.js match")
    check(not r["outerWarnings"] and not r["coreWarnings"], "no warnings for positive crest widths (core width = 1 m)")
    check(any("negative" in w for w in r["negWarnings"]), f"negative crest width warns, not blocks: {r['negWarnings']}")
    check(r["usOnlyNames"] == ["Crest US edge (lake)", "US toe"], f"upstream-only shell -> {r['usOnlyNames']}")
    check(r["legacy"]["axis"] == {"leftmost": {"x": 1, "y": 2}, "rightmost": {"x": 3, "y": 4}}
          and r["legacy"]["groups"] == [["outer shell", 1], ["empty", 0]], f"legacy JSON imports: {r['legacy']}")
    check(r["def"]["groups"] == [["outer shell", 4]] and r["def"]["quick"]["zCrest"] == 523,
          f"default project = outer shell with 4 lines: {r['def']['groups']}")
    check(r["jsonRoundTrip"] == [["outer shell", True, 3.5], ["core", True, -1]], "quick params survive JSON round trip")

    alayers, aents = parse_dxf(r["advDxf"])
    check(len(aents) == 9 and all("38" in e["codes"] for e in aents), f"advanced sample DXF: 9 LWPOLYLINE w/ 38 ({OUT_ADV})")
    check(r["reimported"] == [["outer shell", 4, True], ["core", 4, True]],
          f"sample project JSON re-imports cleanly ({os.path.relpath(OUT_JSON, DIR)})")
    print("All smoke tests passed.")


if __name__ == "__main__":
    main()
