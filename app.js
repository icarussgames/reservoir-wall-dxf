/**
 * Reservoir Wall DXF — Civil 3D Helper
 *
 * Model: Project → shared axis + Shells (groups = CAD layers = materials) → Polylines
 *   project.axis = { leftmost:{x,y}, rightmost:{x,y} }   (UTM Easting/Northing)
 *   group.quick  = per-shell Quick Mode parameters (see defaultQuick())
 *   polyline     = 2D LWPOLYLINE with ONE elevation (DXF group code 38). Never 3D.
 *
 * Axis frame (seen from upstream, standing in the lake):
 *   d = normalize(rightmost - leftmost)
 *   n = (-d.y, d.x)          // CCW-left of d
 *   Upstream / aguas arriba (lake) = −n
 *   Downstream / aguas abajo (dry) = +n
 *
 * Per-shell geometry — every line is the axis offset by a signed distance s along n
 * (exact parallel offset of a 2-point segment: both ends move by s·n):
 *   US crest edge : s = −d_us                       Z = Z_crest
 *   DS crest edge : s = +d_ds                       Z = Z_crest
 *   US toe        : s = −(d_us + usRun)             Z = Z_toe_US
 *   DS toe        : s = +(d_ds + dsRun)             Z = Z_toe_DS
 *   usRun = |Z_crest − Z_toe_US| · (H/V)_US,  dsRun = |Z_crest − Z_toe_DS| · (H/V)_DS
 *   d_us > 0 → toward the lake; d_ds > 0 → toward the dry side; negatives allowed.
 */

(() => {
  "use strict";

  const GROUP_COLORS = [
    "#3b9eff", "#3ecf8e", "#f0b429", "#f07178",
    "#c792ea", "#89ddff", "#ffcb6b", "#82aaff",
  ];
  const DXF_COLORS = [5, 3, 2, 1, 6, 4, 30, 150];

  const DEFAULT_AXIS = {
    leftmost: { x: 350000, y: 6300000 },
    rightmost: { x: 350200, y: 6300010 },
  };

  /**
   * @typedef {{x:number,y:number}} Pt
   * @typedef {{ leftmost: Pt, rightmost: Pt }} Axis
   * @typedef {{ id: string, name: string, elevation: number, closed: boolean, vertices: Pt[], source?: string }} Polyline
   * @typedef {{ zCrest:number, dUs:number, dDs:number, symW:number,
   *   includeUs:boolean, usH:number, usV:number, usZToe:number, usUseDz:boolean, usDz:number,
   *   includeDs:boolean, dsH:number, dsV:number, dsZToe:number, dsUseDz:boolean, dsDz:number }} QuickParams
   * @typedef {{ id: string, name: string, color: string, dxfColor: number, polylines: Polyline[], quick?: QuickParams }} Group
   */

  function defaultQuick() {
    return {
      zCrest: 523,
      dUs: 3.5,
      dDs: 3.5,
      symW: 7,
      includeUs: true,
      usH: 2,
      usV: 1,
      usZToe: 423,
      usUseDz: false,
      usDz: 100,
      includeDs: true,
      dsH: 1,
      dsV: 1,
      dsZToe: 473,
      dsUseDz: false,
      dsDz: 50,
    };
  }

  function cloneAxis(a) {
    return {
      leftmost: { x: Number(a.leftmost.x), y: Number(a.leftmost.y) },
      rightmost: { x: Number(a.rightmost.x), y: Number(a.rightmost.y) },
    };
  }

  function uid(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 10);
  }

  function sanitizeLayerName(name) {
    return String(name || "LAYER")
      .replace(/[<>\/\\":;?*|=`']/g, "_")
      .replace(/\s+/g, " ").trim()  // keep spaces for names like "outer shell"
      .slice(0, 255) || "LAYER";
  }

  // ---------- Geometry helpers ----------

  function normalize(dx, dy) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return null;
    return { x: dx / len, y: dy / len, len };
  }

  /**
   * Unit direction and left normal for axis leftmost→rightmost.
   * n = (-d.y, d.x) is CCW-left when walking along d.
   * Lake/upstream (aguas arriba) is −n; dry/downstream (aguas abajo) is +n.
   */
  function axisFrame(leftmost, rightmost) {
    const d = normalize(rightmost.x - leftmost.x, rightmost.y - leftmost.y);
    if (!d) return null;
    const n = { x: -d.y, y: d.x };
    return { d, n, len: d.len };
  }

  /** Exact parallel offset of a 2-point segment by signed distance along unit normal n. */
  function offsetSegment(a, b, n, dist) {
    return [
      { x: a.x + n.x * dist, y: a.y + n.y * dist },
      { x: b.x + n.x * dist, y: b.y + n.y * dist },
    ];
  }

  function planOffsetDistance(z0, z, slopeRunOverRise) {
    const dz = Math.abs(Number(z) - Number(z0));
    const s = Number(slopeRunOverRise);
    if (!isFinite(dz) || !isFinite(s) || s < 0) return NaN;
    return dz * s;
  }

  function perpUnit(dx, dy, side) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return { x: 0, y: 0 };
    const ux = dx / len;
    const uy = dy / len;
    if (side === "right") return { x: uy, y: -ux };
    return { x: -uy, y: ux };
  }

  function localTangent(pts, i) {
    const n = pts.length;
    if (n < 2) return { x: 1, y: 0 };
    if (i === 0) return { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
    if (i === n - 1) {
      return { x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y };
    }
    const dx1 = pts[i].x - pts[i - 1].x;
    const dy1 = pts[i].y - pts[i - 1].y;
    const dx2 = pts[i + 1].x - pts[i].x;
    const dy2 = pts[i + 1].y - pts[i].y;
    const l1 = Math.hypot(dx1, dy1) || 1;
    const l2 = Math.hypot(dx2, dy2) || 1;
    return { x: dx1 / l1 + dx2 / l2, y: dy1 / l1 + dy2 / l2 };
  }

  function offsetPolylineFromBaseline(baseline, z0, z, slopeRunOverRise, side) {
    const dist = planOffsetDistance(z0, z, slopeRunOverRise);
    if (!isFinite(dist) || !baseline || baseline.length === 0) return [];
    if (dist === 0) return baseline.map((p) => ({ x: p.x, y: p.y }));
    return baseline.map((p, i) => {
      const t = localTangent(baseline, i);
      const n = perpUnit(t.x, t.y, side);
      return { x: p.x + n.x * dist, y: p.y + n.y * dist };
    });
  }

  function parseBaselineText(text) {
    const pts = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/[,;\s]+/).filter(Boolean);
      if (parts.length < 2) continue;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      pts.push({ x, y });
    }
    return pts;
  }

  function round6(n) {
    const x = Number(n);
    if (!isFinite(x)) return 0;
    return Math.round(x * 1e6) / 1e6;
  }

  function makePoly(name, elevation, vertices, closed, source) {
    const p = {
      id: uid("p"),
      name,
      elevation: Number(elevation),
      closed: !!closed,
      vertices: (vertices || []).map((v) => ({ x: v.x, y: v.y })),
    };
    if (source) p.source = source;
    return p;
  }

  function makeGroup(name, colorIdx, polylines, quick) {
    const i = colorIdx % GROUP_COLORS.length;
    const g = {
      id: uid("g"),
      name,
      color: GROUP_COLORS[i],
      dxfColor: DXF_COLORS[i],
      polylines: polylines || [],
    };
    if (quick) g.quick = { ...defaultQuick(), ...quick };
    return g;
  }

  // ---------- Per-shell Quick Mode geometry (pure, DOM-free) ----------

  function num(v, label) {
    const x = Number(v);
    if (v === "" || v === null || v === undefined || !isFinite(x)) {
      throw new Error(`${label} must be a number.`);
    }
    return x;
  }

  function slopeOf(H, V, label) {
    const h = num(H, `${label} H`);
    const v = num(V, `${label} V`);
    if (v === 0) throw new Error(`${label} H:V invalid (V must be ≠ 0).`);
    const s = h / v;
    if (s < 0) throw new Error(`${label} H:V must be ≥ 0.`);
    return s;
  }

  /**
   * Build the Quick Mode polylines for ONE shell from the shared axis.
   * @param {Axis} axis
   * @param {QuickParams} q
   * @returns {{ polylines: Polyline[], warnings: string[], hint: string, offsets: object }}
   */
  function buildShellPolylines(axis, q) {
    if (!axis || !axis.leftmost || !axis.rightmost) throw new Error("Axis is not set.");
    const L = { x: num(axis.leftmost.x, "Leftmost Easting"), y: num(axis.leftmost.y, "Leftmost Northing") };
    const R = { x: num(axis.rightmost.x, "Rightmost Easting"), y: num(axis.rightmost.y, "Rightmost Northing") };
    const frame = axisFrame(L, R);
    if (!frame) throw new Error("Leftmost and rightmost points must be distinct.");
    const { n } = frame;

    const includeUs = q.includeUs !== false;
    const includeDs = q.includeDs !== false;
    if (!includeUs && !includeDs) throw new Error("Include at least one side (upstream or downstream).");

    const zCrest = num(q.zCrest, "Crest elevation");
    const polylines = [];
    const warnings = [];
    const offsets = {};
    const hintParts = [`Axis ${round6(frame.len)} m`];

    let dUs = null;
    let dDs = null;

    if (includeUs) {
      dUs = num(q.dUs, "US crest distance");
      const usSlope = slopeOf(q.usH, q.usV, "Upstream");
      let usZToe;
      if (q.usUseDz) {
        const dz = num(q.usDz, "Upstream ΔZ");
        if (dz < 0) throw new Error("Upstream ΔZ must be ≥ 0.");
        usZToe = zCrest - dz;
      } else {
        usZToe = num(q.usZToe, "Upstream toe elevation");
      }
      const usRun = planOffsetDistance(zCrest, usZToe, usSlope);
      // Lake side is −n: crest edge at −d_us, toe further out at −(d_us + run)
      const sCrest = -dUs;
      const sToe = -(dUs + usRun);
      polylines.push(makePoly("Crest US edge (lake)", zCrest, offsetSegment(L, R, n, sCrest), false, "quick"));
      polylines.push(makePoly("US toe", usZToe, offsetSegment(L, R, n, sToe), false, "quick"));
      offsets.usCrest = sCrest;
      offsets.usToe = sToe;
      if (usZToe > zCrest) warnings.push(`US toe (${usZToe}) is above the crest (${zCrest}).`);
      hintParts.push(`US: edge ${round6(dUs)} m lake-side, run ${round6(usRun)} m (Z ${zCrest}→${usZToe}, ${round6(usSlope)}:1)`);
    }

    if (includeDs) {
      dDs = num(q.dDs, "DS crest distance");
      const dsSlope = slopeOf(q.dsH, q.dsV, "Downstream");
      let dsZToe;
      if (q.dsUseDz) {
        const dz = num(q.dsDz, "Downstream ΔZ");
        if (dz < 0) throw new Error("Downstream ΔZ must be ≥ 0.");
        dsZToe = zCrest - dz;
      } else {
        dsZToe = num(q.dsZToe, "Downstream toe elevation");
      }
      const dsRun = planOffsetDistance(zCrest, dsZToe, dsSlope);
      // Dry side is +n: crest edge at +d_ds, toe further out at +(d_ds + run)
      const sCrest = +dDs;
      const sToe = +(dDs + dsRun);
      polylines.push(makePoly("Crest DS edge (dry)", zCrest, offsetSegment(L, R, n, sCrest), false, "quick"));
      polylines.push(makePoly("DS toe", dsZToe, offsetSegment(L, R, n, sToe), false, "quick"));
      offsets.dsCrest = sCrest;
      offsets.dsToe = sToe;
      if (dsZToe > zCrest) warnings.push(`DS toe (${dsZToe}) is above the crest (${zCrest}).`);
      hintParts.push(`DS: edge ${round6(dDs)} m dry-side, run ${round6(dsRun)} m (Z ${zCrest}→${dsZToe}, ${round6(dsSlope)}:1)`);
    }

    if (includeUs && includeDs) {
      const width = dUs + dDs; // = offsets.dsCrest − offsets.usCrest
      hintParts.push(`crest width ${round6(width)} m`);
      if (width < 0) {
        warnings.push(
          `Crest width is negative (${round6(width)} m): the US crest edge lies on the dry side of the DS crest edge.`
        );
      }
    }

    return { polylines, warnings, hint: hintParts.join(" · "), offsets };
  }

  /** Default project: shared axis + one "outer shell" generated from default params. */
  function defaultProject() {
    const axis = cloneAxis(DEFAULT_AXIS);
    const g = makeGroup("outer shell", 0, [], defaultQuick());
    g.polylines = buildShellPolylines(axis, g.quick).polylines;
    return { name: "Reservoir Wall Quick", units: "meters (UTM)", axis, groups: [g] };
  }

  /**
   * Normalize an imported (possibly old-format) project so the app never crashes.
   * - old `quickAxis` {leftmost,rightmost} or {p0,p1} → `axis`
   * - missing ids / colors / polylines / vertices filled in
   * - `quick` left undefined when absent (defaults are applied lazily on selection)
   */
  function normalizeProject(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.groups)) {
      throw new Error("Invalid project JSON (no groups array).");
    }
    const proj = {
      name: data.name || "Imported project",
      units: data.units || "meters",
      axis: null,
      groups: [],
    };
    const src = data.axis || data.quickAxis;
    if (src) {
      const a0 = src.leftmost || src.p0;
      const a1 = src.rightmost || src.p1;
      if (a0 && a1 && [a0.x, a0.y, a1.x, a1.y].every((v) => isFinite(Number(v)))) {
        proj.axis = cloneAxis({ leftmost: a0, rightmost: a1 });
      }
    }
    data.groups.forEach((g, i) => {
      if (!g || typeof g !== "object") return;
      const out = {
        id: g.id || uid("g"),
        name: g.name || `shell ${i + 1}`,
        color: g.color || GROUP_COLORS[i % GROUP_COLORS.length],
        dxfColor: g.dxfColor || DXF_COLORS[i % DXF_COLORS.length],
        polylines: [],
      };
      if (g.quick && typeof g.quick === "object") out.quick = { ...defaultQuick(), ...g.quick };
      (Array.isArray(g.polylines) ? g.polylines : []).forEach((p, j) => {
        if (!p || typeof p !== "object") return;
        const pl = {
          id: p.id || uid("p"),
          name: p.name || `Polyline ${j + 1}`,
          elevation: Number(p.elevation),
          closed: !!p.closed,
          vertices: (Array.isArray(p.vertices) ? p.vertices : [])
            .filter((v) => v && typeof v === "object")
            .map((v) => ({ x: Number(v.x), y: Number(v.y) })),
        };
        if (p.source) pl.source = p.source;
        out.polylines.push(pl);
      });
      proj.groups.push(out);
    });
    return proj;
  }

  // ---------- Advanced sample ----------
  function sampleProject() {
    const baseline = [
      { x: 0, y: 0 },
      { x: 40, y: 2 },
      { x: 80, y: 0 },
      { x: 120, y: -3 },
      { x: 160, y: 0 },
    ];
    const Z0 = 100;
    function offset(side, Z, H, V) {
      return offsetPolylineFromBaseline(baseline, Z0, Z, H / V, side);
    }
    return {
      name: "Reservoir Wall A",
      units: "meters",
      axis: null,
      groups: [
        makeGroup("Upstream shell", 0, [
          makePoly("US crest", 120, offset("left", 120, 2.5, 1)),
          makePoly("US berm", 110, offset("left", 110, 2.5, 1)),
          makePoly("US toe", 100, offset("left", 100, 2.5, 1)),
        ]),
        makeGroup("Core", 1, [
          makePoly("Core crest", 120, offset("left", 120, 0.3, 1)),
          makePoly("Core mid", 110, offset("left", 110, 0.3, 1)),
          makePoly("Core base", 100, baseline.map((p) => ({ ...p }))),
        ]),
        makeGroup("Downstream shell", 2, [
          makePoly("DS crest", 120, offset("right", 120, 2.0, 1)),
          makePoly("DS berm", 110, offset("right", 110, 2.0, 1)),
          makePoly("DS toe", 100, offset("right", 100, 2.0, 1)),
        ]),
      ],
    };
  }

  // ---------- DXF export ----------
  function exportDxf(proj) {
    const lines = [];
    const push = (code, value) => {
      lines.push(String(code));
      lines.push(String(value));
    };

    push(0, "SECTION");
    push(2, "HEADER");
    push(9, "$ACADVER");
    push(1, "AC1015");
    push(9, "$INSUNITS");
    push(70, 6);
    push(0, "ENDSEC");

    push(0, "SECTION");
    push(2, "TABLES");
    push(0, "TABLE");
    push(2, "LAYER");
    push(70, Math.max(proj.groups.length, 1));
    push(0, "LAYER");
    push(2, "0");
    push(70, 0);
    push(62, 7);
    push(6, "CONTINUOUS");
    for (const g of proj.groups) {
      push(0, "LAYER");
      push(2, sanitizeLayerName(g.name));
      push(70, 0);
      push(62, g.dxfColor || 7);
      push(6, "CONTINUOUS");
    }
    push(0, "ENDTAB");
    push(0, "ENDSEC");

    push(0, "SECTION");
    push(2, "ENTITIES");
    for (const g of proj.groups) {
      const layer = sanitizeLayerName(g.name);
      for (const pl of g.polylines) {
        if (!pl.vertices || pl.vertices.length < 2) continue;
        push(0, "LWPOLYLINE");
        push(8, layer);
        push(38, Number(pl.elevation) || 0);   // one elevation for the whole polyline
        push(90, pl.vertices.length);
        push(70, pl.closed ? 1 : 0);
        for (const v of pl.vertices) {         // 2D vertices only — no group code 30
          push(10, round6(v.x));
          push(20, round6(v.y));
        }
      }
    }
    push(0, "ENDSEC");
    push(0, "EOF");
    return lines.join("\n") + "\n";
  }

  // ---------- Validation ----------
  function validateProject(proj) {
    const issues = [];
    if (!proj.name || !String(proj.name).trim()) {
      issues.push({ level: "error", msg: "Project name is empty." });
    }
    const groupNames = new Set();
    for (const g of proj.groups) {
      if (!g.name || !String(g.name).trim()) {
        issues.push({ level: "error", msg: "A shell has an empty name." });
      } else {
        const key = sanitizeLayerName(g.name).toLowerCase();
        if (groupNames.has(key)) {
          issues.push({ level: "warn", msg: `Duplicate layer name after sanitize: "${g.name}"` });
        }
        groupNames.add(key);
      }
      if (!g.polylines.length) {
        issues.push({ level: "warn", msg: `Shell "${g.name}" has no polylines yet (Generate this shell).` });
      }
      for (const pl of g.polylines) {
        if (!pl.name || !String(pl.name).trim()) {
          issues.push({ level: "error", msg: `Polyline in "${g.name}" has empty name.` });
        }
        if (!isFinite(Number(pl.elevation))) {
          issues.push({ level: "error", msg: `"${pl.name}" elevation is not numeric.` });
        }
        if (!pl.vertices || pl.vertices.length === 0) {
          issues.push({ level: "warn", msg: `"${pl.name}" in "${g.name}" has no vertices.` });
        } else if (pl.vertices.length < 2) {
          issues.push({ level: "warn", msg: `"${pl.name}" needs ≥2 vertices for DXF export.` });
        }
        for (let i = 0; i < (pl.vertices || []).length; i++) {
          const v = pl.vertices[i];
          if (!isFinite(v.x) || !isFinite(v.y)) {
            issues.push({ level: "error", msg: `"${pl.name}" vertex ${i + 1} has non-numeric coords.` });
          }
        }
      }
      if (g.quick && proj.axis) {
        try {
          const r = buildShellPolylines(proj.axis, g.quick);
          r.warnings.forEach((w) => issues.push({ level: "warn", msg: `"${g.name}": ${w}` }));
        } catch (_) { /* invalid params are reported in the Quick Mode panel */ }
      }
    }
    return issues;
  }

  const api = {
    DEFAULT_AXIS,
    defaultQuick,
    defaultProject,
    normalizeProject,
    buildShellPolylines,
    exportDxf,
    sampleProject,
    offsetPolylineFromBaseline,
    offsetSegment,
    axisFrame,
    planOffsetDistance,
    sanitizeLayerName,
    validateProject,
    makeGroup,
  };

  // Node / headless: expose pure functions, skip all DOM wiring.
  if (typeof document === "undefined") {
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return;
  }

  // =====================================================================
  // DOM / UI
  // =====================================================================

  let project = defaultProject();
  let selectedGroupId = project.groups[0].id;
  let selectedPolyId = null;
  const view = { cx: 0, cy: 0, scale: 1 };

  const $ = (sel) => document.querySelector(sel);

  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show " + (kind || "ok");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 3600);
  }

  function selectedGroup() {
    return project.groups.find((g) => g.id === selectedGroupId) || null;
  }

  function selectedPoly() {
    const g = selectedGroup();
    if (!g) return null;
    return g.polylines.find((p) => p.id === selectedPolyId) || null;
  }

  function ensureQuick(g) {
    if (!g.quick) g.quick = defaultQuick();
    return g.quick;
  }

  function setMode(mode) {
    const quick = mode === "quick";
    $("#tabQuick").classList.toggle("active", quick);
    $("#tabAdvanced").classList.toggle("active", !quick);
    $("#panelQuick").hidden = !quick;
    $("#panelAdvanced").hidden = quick;
  }

  // ---------- Shared axis panel ----------
  const AXIS_FIELDS = [
    ["axLeftE", "leftmost", "x"],
    ["axLeftN", "leftmost", "y"],
    ["axRightE", "rightmost", "x"],
    ["axRightN", "rightmost", "y"],
  ];

  function readAxisFields() {
    const a = { leftmost: {}, rightmost: {} };
    for (const [id, pt, k] of AXIS_FIELDS) a[pt][k] = Number($("#" + id).value);
    return a;
  }

  function writeAxisFields(axis) {
    if (!axis) return; // keep whatever the fields show (defaults) until the user generates
    for (const [id, pt, k] of AXIS_FIELDS) $("#" + id).value = axis[pt][k];
  }

  function onAxisInput() {
    const a = readAxisFields();
    const ok = [a.leftmost.x, a.leftmost.y, a.rightmost.x, a.rightmost.y].every(isFinite);
    const frame = ok ? axisFrame(a.leftmost, a.rightmost) : null;
    if (frame) {
      project.axis = a;
      $("#axisHint").textContent =
        `Length ${round6(frame.len)} m. Moving the axis does not move existing lines — ` +
        `press Generate on a shell (or Regenerate all).`;
    } else {
      $("#axisHint").textContent = "Enter two distinct numeric UTM points.";
    }
    updateQmLiveHint();
    renderPreview();
  }

  // ---------- Per-shell Quick Mode panel ----------
  // [elementId, key, kind]
  const QM_FIELDS = [
    ["qmZCrest", "zCrest", "num"],
    ["qmDUs", "dUs", "num"],
    ["qmDDs", "dDs", "num"],
    ["qmSymW", "symW", "num"],
    ["qmIncUs", "includeUs", "bool"],
    ["qmUsH", "usH", "num"],
    ["qmUsV", "usV", "num"],
    ["qmUsZToe", "usZToe", "num"],
    ["qmUsUseDz", "usUseDz", "bool"],
    ["qmUsDz", "usDz", "num"],
    ["qmIncDs", "includeDs", "bool"],
    ["qmDsH", "dsH", "num"],
    ["qmDsV", "dsV", "num"],
    ["qmDsZToe", "dsZToe", "num"],
    ["qmDsUseDz", "dsUseDz", "bool"],
    ["qmDsDz", "dsDz", "num"],
  ];

  function renderQuickPanel() {
    const g = selectedGroup();
    $("#qmNoShell").hidden = !!g;
    $("#qmForm").hidden = !g;
    if (!g) return;
    const q = ensureQuick(g);
    $("#qmShellName").textContent = g.name;
    for (const [id, key, kind] of QM_FIELDS) {
      const el = $("#" + id);
      if (kind === "bool") el.checked = !!q[key];
      else el.value = q[key] === undefined || q[key] === null ? "" : q[key];
    }
    syncQmVisibility();
    updateQmLiveHint();
  }

  function onQuickFieldInput(e) {
    const g = selectedGroup();
    if (!g) return;
    const q = ensureQuick(g);
    const def = QM_FIELDS.find(([id]) => id === e.target.id);
    if (!def) return;
    const [, key, kind] = def;
    if (kind === "bool") q[key] = e.target.checked;
    else q[key] = e.target.value === "" ? "" : Number(e.target.value);
    syncQmVisibility();
    updateQmLiveHint();
  }

  function syncQmVisibility() {
    const usDz = $("#qmUsUseDz").checked;
    const dsDz = $("#qmDsUseDz").checked;
    $("#qmUsDzWrap").style.display = usDz ? "" : "none";
    $("#qmUsZToeWrap").style.display = usDz ? "none" : "";
    $("#qmDsDzWrap").style.display = dsDz ? "" : "none";
    $("#qmDsZToeWrap").style.display = dsDz ? "none" : "";
    $("#qmUsFields").classList.toggle("fields-off", !$("#qmIncUs").checked);
    $("#qmDsFields").classList.toggle("fields-off", !$("#qmIncDs").checked);
    $("#qmDUs").disabled = !$("#qmIncUs").checked;
    $("#qmDDs").disabled = !$("#qmIncDs").checked;
  }

  function updateQmLiveHint() {
    const g = selectedGroup();
    const hintEl = $("#qmHint");
    const warnEl = $("#qmWarn");
    if (!g) { hintEl.textContent = ""; warnEl.hidden = true; return; }
    try {
      const r = buildShellPolylines(project.axis || readAxisFields(), ensureQuick(g));
      hintEl.textContent = "Preview: " + r.hint;
      if (r.warnings.length) {
        warnEl.hidden = false;
        warnEl.innerHTML = r.warnings.map((w) => "⚠ " + escapeHtml(w)).join("<br>");
      } else {
        warnEl.hidden = true;
      }
    } catch (err) {
      hintEl.textContent = "";
      warnEl.hidden = false;
      warnEl.textContent = "⚠ " + (err.message || String(err));
    }
  }

  function symmetricFromW() {
    const g = selectedGroup();
    if (!g) return;
    const W = Number($("#qmSymW").value);
    if (!isFinite(W) || W < 0) { toast("Enter a width W ≥ 0.", "error"); return; }
    const q = ensureQuick(g);
    q.symW = W;
    q.dUs = W / 2;
    q.dDs = W / 2;
    renderQuickPanel();
    toast(`d_US = d_DS = ${round6(W / 2)} m. Press "Generate this shell" to apply.`, "ok");
  }

  /** Regenerate one shell's polylines from the shared axis + its quick params. */
  function generateShell(g, opts) {
    const skipConfirm = opts && opts.skipConfirm;
    const axis = readAxisFields();
    const built = buildShellPolylines(axis, ensureQuick(g)); // throws on invalid input
    if (!skipConfirm && g.polylines.length) {
      const manual = g.polylines.filter((p) => p.source !== "quick").length;
      const msg =
        `Replace all ${g.polylines.length} polyline(s) in shell "${g.name}" with the Quick Mode result?` +
        (manual ? `\n(${manual} of them were added or imported manually and will be removed too.)` : "") +
        "\nOther shells are not touched.";
      if (!confirm(msg)) return null;
    }
    project.axis = cloneAxis(axis);
    g.polylines = built.polylines;
    return built;
  }

  function onGenerateShell() {
    const g = selectedGroup();
    if (!g) { toast("Select or add a shell first.", "warn"); return; }
    try {
      const built = generateShell(g, { skipConfirm: false });
      if (!built) return;
      selectedPolyId = null;
      renderAll();
      fitView();
      if (built.warnings.length) toast(`Shell "${g.name}" generated with warnings: ${built.warnings[0]}`, "warn");
      else toast(`Shell "${g.name}" generated (${built.polylines.length} polylines).`, "ok");
    } catch (err) {
      toast(err.message || String(err), "error");
    }
  }

  function onRegenerateAll() {
    const shells = project.groups;
    if (!shells.length) { toast("No shells to regenerate.", "warn"); return; }
    if (!confirm(
      `Regenerate all ${shells.length} shell(s) from the axis and each shell's Quick Mode values?\n` +
      "This replaces every shell's polylines (manual edits included)."
    )) return;
    const failed = [];
    for (const g of shells) {
      try { generateShell(g, { skipConfirm: true }); }
      catch (err) { failed.push(`${g.name}: ${err.message}`); }
    }
    selectedPolyId = null;
    renderAll();
    fitView();
    if (failed.length) toast("Some shells failed — " + failed.join("; "), "error");
    else toast(`Regenerated ${shells.length} shell(s).`, "ok");
  }

  // ---------- Render ----------
  function renderAll() {
    $("#projectName").value = project.name;
    $("#projectUnits").value = project.units || "meters";
    writeAxisFields(project.axis);
    renderGroups();
    renderPolys();
    renderPolyDetail();
    renderQuickPanel();
    renderPreview();
    renderValidation();
  }

  function renderGroups() {
    const ul = $("#groupList");
    ul.innerHTML = "";
    if (!project.groups.length) {
      ul.innerHTML = '<li class="empty">No shells yet. Click “+ Add shell”.</li>';
      return;
    }
    project.groups.forEach((g, idx) => {
      const li = document.createElement("li");
      li.className = "list-item" + (g.id === selectedGroupId ? " active" : "");
      li.innerHTML = `
        <span class="swatch" style="background:${g.color}"></span>
        <span class="name" title="${escapeAttr(g.name)}">${escapeHtml(g.name)}</span>
        <span class="meta">${g.polylines.length}</span>
        <span class="item-actions">
          <button class="btn btn-sm btn-ghost" data-act="up" title="Move up">↑</button>
          <button class="btn btn-sm btn-ghost" data-act="down" title="Move down">↓</button>
          <button class="btn btn-sm btn-ghost" data-act="rename" title="Rename">✎</button>
          <button class="btn btn-sm btn-ghost btn-danger" data-act="del" title="Delete">✕</button>
        </span>
      `;
      li.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset?.act;
        if (act === "up") { e.stopPropagation(); moveGroup(idx, -1); return; }
        if (act === "down") { e.stopPropagation(); moveGroup(idx, 1); return; }
        if (act === "rename") {
          e.stopPropagation();
          const n = prompt("Shell / CAD layer name:", g.name);
          if (n != null && n.trim()) { g.name = n.trim(); renderAll(); }
          return;
        }
        if (act === "del") {
          e.stopPropagation();
          if (confirm(`Delete shell "${g.name}" and all its polylines?`)) {
            project.groups = project.groups.filter((x) => x.id !== g.id);
            if (selectedGroupId === g.id) {
              selectedGroupId = project.groups[0]?.id || null;
              selectedPolyId = null;
            }
            renderAll();
          }
          return;
        }
        selectedGroupId = g.id;
        selectedPolyId = null;
        setMode("quick");
        renderAll();
      });
      ul.appendChild(li);
    });
  }

  function moveGroup(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= project.groups.length) return;
    const tmp = project.groups[idx];
    project.groups[idx] = project.groups[j];
    project.groups[j] = tmp;
    renderAll();
  }

  function renderPolys() {
    const ul = $("#polyList");
    const g = selectedGroup();
    ul.innerHTML = "";
    if (!g) {
      ul.innerHTML = '<li class="empty">Select a shell.</li>';
      return;
    }
    if (!g.polylines.length) {
      ul.innerHTML = '<li class="empty">No polylines. Press “Generate this shell”, or add one manually.</li>';
      return;
    }
    g.polylines.forEach((pl) => {
      const li = document.createElement("li");
      li.className = "list-item" + (pl.id === selectedPolyId ? " active" : "");
      li.innerHTML = `
        <span class="name">${escapeHtml(pl.name)}${pl.source === "quick" ? '<span class="badge-quick">quick</span>' : ""}</span>
        <span class="meta">Z=${pl.elevation} · ${pl.vertices.length} pts${pl.closed ? " · closed" : ""}</span>
        <span class="item-actions">
          <button class="btn btn-sm btn-ghost btn-danger" data-act="del">✕</button>
        </span>
      `;
      li.addEventListener("click", (e) => {
        if (e.target.closest("[data-act]")?.dataset?.act === "del") {
          e.stopPropagation();
          if (confirm(`Delete polyline "${pl.name}"?`)) {
            g.polylines = g.polylines.filter((x) => x.id !== pl.id);
            if (selectedPolyId === pl.id) selectedPolyId = null;
            renderAll();
          }
          return;
        }
        selectedPolyId = pl.id;
        renderGroups();
        renderPolys();
        renderPolyDetail();
        renderPreview();
      });
      ul.appendChild(li);
    });
  }

  function renderPolyDetail() {
    const box = $("#polyDetail");
    const pl = selectedPoly();
    if (!pl) {
      box.className = "empty";
      box.textContent = "Select or add a polyline to edit vertices and elevation.";
      return;
    }
    box.className = "";
    box.innerHTML = `
      <div class="row">
        <label class="field">Name
          <input type="text" id="plName" value="${escapeAttr(pl.name)}" />
        </label>
        <label class="field">Elevation (DXF 38)
          <input type="number" id="plElev" step="any" value="${pl.elevation}" />
        </label>
        <label class="field inline" style="flex:0;padding-bottom:6px">
          <input type="checkbox" id="plClosed" ${pl.closed ? "checked" : ""} /> Closed
        </label>
      </div>
      <div class="panel-title" style="margin-top:4px">
        Manual vertices (Easting X, Northing Y)
        <span><button class="btn btn-sm" id="btnAddVert" type="button">+ Vertex</button></span>
      </div>
      <div class="table-wrap">
        <table class="verts">
          <thead><tr><th class="idx">#</th><th>Easting (X)</th><th>Northing (Y)</th><th class="act"></th></tr></thead>
          <tbody id="vertBody"></tbody>
        </table>
      </div>
    `;
    const tbody = $("#vertBody");
    pl.vertices.forEach((v, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="idx">${i + 1}</td>
        <td><input type="number" step="any" data-i="${i}" data-f="x" value="${v.x}" /></td>
        <td><input type="number" step="any" data-i="${i}" data-f="y" value="${v.y}" /></td>
        <td class="act"><button class="btn btn-sm btn-ghost btn-danger" data-del="${i}" type="button">✕</button></td>
      `;
      tbody.appendChild(tr);
    });
    $("#plName").addEventListener("change", (e) => {
      pl.name = e.target.value; renderPolys(); renderValidation(); renderPreview();
    });
    $("#plElev").addEventListener("change", (e) => {
      pl.elevation = Number(e.target.value); renderPolys(); renderValidation(); renderPreview();
    });
    $("#plClosed").addEventListener("change", (e) => {
      pl.closed = e.target.checked; renderPolys(); renderPreview();
    });
    tbody.addEventListener("change", (e) => {
      const inp = e.target.closest("input[data-f]");
      if (!inp) return;
      pl.vertices[Number(inp.dataset.i)][inp.dataset.f] = Number(inp.value);
      renderPolys(); renderValidation(); renderPreview();
    });
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-del]");
      if (!btn) return;
      pl.vertices.splice(Number(btn.dataset.del), 1);
      renderPolyDetail(); renderPolys(); renderValidation(); renderPreview();
    });
    $("#btnAddVert").addEventListener("click", () => {
      const last = pl.vertices[pl.vertices.length - 1];
      pl.vertices.push({ x: last ? last.x + 10 : 0, y: last ? last.y : 0 });
      renderPolyDetail(); renderPolys(); renderPreview();
    });
  }

  function renderValidation() {
    const issues = validateProject(project);
    const html = !issues.length
      ? null
      : issues
          .map(
            (i) =>
              `<div style="color:${i.level === "error" ? "var(--danger)" : "var(--warn)"};font-size:12px;margin:4px 0">
                [${i.level}] ${escapeHtml(i.msg)}
              </div>`
          )
          .join("");
    for (const id of ["validationBox", "validationBoxQuick"]) {
      const box = $("#" + id);
      if (!box) continue;
      if (!html) {
        box.className = "empty";
        box.textContent = "No issues.";
      } else {
        box.className = "";
        box.innerHTML = html;
      }
    }
  }

  // ---------- SVG preview ----------
  function allVisiblePolys() {
    const showAll = $("#showAllGroups").checked;
    const groups = showAll
      ? project.groups
      : project.groups.filter((g) => g.id === selectedGroupId);
    const out = [];
    for (const g of groups) {
      for (const pl of g.polylines) {
        if (pl.vertices && pl.vertices.length) out.push({ group: g, poly: pl });
      }
    }
    return out;
  }

  function boundsOf(items) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x, y) => {
      if (!isFinite(x) || !isFinite(y)) return;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    for (const { poly } of items) {
      for (const v of poly.vertices) consider(v.x, v.y);
    }
    if (project.axis) {
      consider(project.axis.leftmost.x, project.axis.leftmost.y);
      consider(project.axis.rightmost.x, project.axis.rightmost.y);
    }
    if (!isFinite(minX)) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    if (minX === maxX) { minX -= 1; maxX += 1; }
    if (minY === maxY) { minY -= 1; maxY += 1; }
    return { minX, minY, maxX, maxY };
  }

  function fitView() {
    const svg = $("#planPreview");
    const rect = svg.getBoundingClientRect();
    const w = rect.width || 600;
    const h = rect.height || 400;
    const b = boundsOf(allVisiblePolys());
    const pad = 0.12;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    view.scale = Math.min(w / (bw * (1 + 2 * pad)), h / (bh * (1 + 2 * pad)));
    view.cx = (b.minX + b.maxX) / 2;
    view.cy = (b.minY + b.maxY) / 2;
    renderPreview();
  }

  function worldToSvg(x, y, w, h) {
    return {
      x: w / 2 + (x - view.cx) * view.scale,
      y: h / 2 - (y - view.cy) * view.scale,
    };
  }

  function renderPreview() {
    const svg = $("#planPreview");
    const rect = svg.getBoundingClientRect();
    const w = rect.width || 600;
    const h = rect.height || 400;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const showLabels = $("#showElevLabels").checked;
    const showAxis = $("#showAxis").checked;
    const items = allVisiblePolys();
    const font = 'font-family="system-ui"';

    let html = `<rect x="0" y="0" width="${w}" height="${h}" fill="#0a0e14"/>`;

    // Shared axis (dashed) under the polylines — leftmost → rightmost
    if (showAxis && project.axis) {
      const a = worldToSvg(project.axis.leftmost.x, project.axis.leftmost.y, w, h);
      const b = worldToSvg(project.axis.rightmost.x, project.axis.rightmost.y, w, h);
      if ([a.x, a.y, b.x, b.y].every(isFinite)) {
        html += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#8b9bb4" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.9"/>`;
        html += `<circle cx="${a.x}" cy="${a.y}" r="3.5" fill="#8b9bb4"/>`;
        html += `<circle cx="${b.x}" cy="${b.y}" r="3.5" fill="#8b9bb4"/>`;
        html += `<text x="${a.x + 6}" y="${a.y - 8}" fill="#8b9bb4" font-size="10" ${font}>Leftmost</text>`;
        html += `<text x="${b.x + 6}" y="${b.y - 8}" fill="#8b9bb4" font-size="10" ${font}>Rightmost</text>`;
      }
    }

    for (const { group, poly } of items) {
      const pts = poly.vertices.map((v) => worldToSvg(v.x, v.y, w, h));
      if (pts.length < 1) continue;
      let d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      if (poly.closed && pts.length > 2) d += " Z";
      const isSel = poly.id === selectedPolyId;
      const inSelShell = group.id === selectedGroupId;
      html += `<path d="${d}" fill="none" stroke="${group.color}" stroke-width="${isSel ? 3 : inSelShell ? 2 : 1.3}" opacity="${isSel || inSelShell ? 1 : 0.6}"/>`;
      for (const p of pts) {
        html += `<circle cx="${p.x}" cy="${p.y}" r="${isSel ? 3.5 : 2}" fill="${group.color}"/>`;
      }
      if (showLabels && pts.length) {
        const mid = pts[Math.floor(pts.length / 2)];
        html += `<text x="${mid.x + 6}" y="${mid.y - 6}" fill="${group.color}" font-size="11" ${font}>${escapeHtml(String(poly.elevation))}</text>`;
      }
    }

    // Legends: side convention (top-left) + shell colors (bottom-left)
    html += `<text x="10" y="18" fill="#c8d3e3" font-size="11" ${font}>US = lake / aguas arriba (−n)</text>`;
    html += `<text x="10" y="34" fill="#c8d3e3" font-size="11" ${font}>DS = dry / aguas abajo (+n)</text>`;
    project.groups.forEach((g, i) => {
      const y = h - 12 - (project.groups.length - 1 - i) * 16;
      html += `<rect x="10" y="${y - 9}" width="10" height="10" rx="2" fill="${g.color}"/>`;
      html += `<text x="26" y="${y}" fill="#c8d3e3" font-size="11" ${font}>${escapeHtml(g.name)}</text>`;
    });

    svg.innerHTML = html;
  }

  // ---------- Actions ----------
  function addShell() {
    const n = prompt("New shell / CAD layer name:", project.groups.length ? "core" : "outer shell");
    if (n == null || !n.trim()) return;
    const src = selectedGroup();
    const quick = src ? { ...ensureQuick(src) } : defaultQuick();
    const g = makeGroup(n.trim(), project.groups.length, [], quick);
    project.groups.push(g);
    selectedGroupId = g.id;
    selectedPolyId = null;
    setMode("quick");
    renderAll();
    toast(
      src
        ? `Shell "${g.name}" created with "${src.name}"'s Quick Mode values. Adjust them, then Generate this shell.`
        : `Shell "${g.name}" created. Set its values, then Generate this shell.`,
      "ok"
    );
  }

  function addPolyline() {
    const g = selectedGroup();
    if (!g) { toast("Select or create a shell first.", "warn"); return; }
    const base = project.axis ? project.axis.leftmost : { x: 0, y: 0 };
    const pl = makePoly("Polyline " + (g.polylines.length + 1), 0, [
      { x: base.x, y: base.y }, { x: base.x + 10, y: base.y },
    ]);
    g.polylines.push(pl);
    selectedPolyId = pl.id;
    renderAll();
  }

  function generateOffset() {
    const g = selectedGroup();
    if (!g) { toast("Select a shell first.", "warn"); return; }
    const baseline = parseBaselineText($("#baselinePts").value);
    if (baseline.length < 2) {
      toast("Need at least 2 baseline points (x,y per line).", "error");
      return;
    }
    const z0 = Number($("#refElev").value);
    const z = Number($("#targetElev").value);
    let slope;
    if ($("#inclMode").value === "hv") {
      const H = Number($("#inclH").value);
      const V = Number($("#inclV").value);
      if (!isFinite(H) || !isFinite(V) || V === 0) {
        toast("Invalid H:V (V must be ≠ 0).", "error");
        return;
      }
      slope = H / V;
    } else {
      slope = Number($("#inclSlope").value);
      if (!isFinite(slope) || slope < 0) {
        toast("Invalid decimal slope.", "error");
        return;
      }
    }
    const side = $("#offsetSide").value;
    const dist = planOffsetDistance(z0, z, slope);
    const verts = offsetPolylineFromBaseline(baseline, z0, z, slope, side);
    const name = ($("#genPolyName").value || "Offset line").trim();
    g.polylines.push(makePoly(name, z, verts, $("#genClosed").checked));
    selectedPolyId = g.polylines[g.polylines.length - 1].id;
    $("#offsetPreviewHint").textContent =
      `Offset distance = |${z} − ${z0}| × ${round6(slope)} = ${round6(dist)} (plan units), side=${side}.`;
    renderAll();
    fitView();
    toast(`Generated "${name}" with ${verts.length} vertices.`, "ok");
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function doExportDxf() {
    const issues = validateProject(project);
    if (issues.some((i) => i.level === "error")) {
      toast("Fix validation errors before export.", "error");
      renderValidation();
      return;
    }
    const warns = issues.filter((i) => i.level === "warn");
    downloadText(
      sanitizeLayerName(project.name || "project") + ".dxf",
      exportDxf(project),
      "application/dxf"
    );
    if (warns.length) toast(`DXF downloaded with ${warns.length} warning(s) — see Validation.`, "warn");
    else toast("DXF downloaded.", "ok");
  }

  function doExportJson() {
    // project already holds axis + per-shell quick params
    downloadText(
      sanitizeLayerName(project.name || "project") + ".json",
      JSON.stringify(project, null, 2),
      "application/json"
    );
    toast("JSON exported (axis + shells + Quick Mode values).", "ok");
  }

  function doImportJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        project = normalizeProject(JSON.parse(reader.result));
        selectedGroupId = project.groups[0]?.id || null;
        selectedPolyId = null;
        setMode("quick");
        renderAll();
        fitView();
        const noQuick = project.groups.filter((g) => !g.quick).length;
        toast(
          "Project imported." +
            (noQuick ? ` ${noQuick} shell(s) had no Quick Mode values — defaults shown; existing lines kept until you Generate.` : "") +
            (project.axis ? "" : " No axis in file — axis fields kept as they were."),
          "ok"
        );
      } catch (err) {
        toast("Import failed: " + err.message, "error");
      }
    };
    reader.readAsText(file);
  }

  function newDefaultProject() {
    if (project.groups.some((g) => g.polylines.length) &&
        !confirm("Replace the current project with the default one (axis + outer shell)?")) return;
    project = defaultProject();
    selectedGroupId = project.groups[0].id;
    selectedPolyId = null;
    setMode("quick");
    renderAll();
    fitView();
    toast("Default project loaded.", "ok");
  }

  function loadSample() {
    if (project.groups.some((g) => g.polylines.length) &&
        !confirm("Replace the current project with the advanced (non-axis) sample?")) return;
    project = sampleProject();
    selectedGroupId = project.groups[0].id;
    selectedPolyId = null;
    $("#baselinePts").value = "0, 0\n40, 2\n80, 0\n120, -3\n160, 0";
    $("#refElev").value = "100";
    setMode("advanced");
    renderAll();
    fitView();
    toast("Advanced sample Reservoir Wall A loaded.", "ok");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  // ---------- Wire UI ----------
  function bind() {
    $("#tabQuick").addEventListener("click", () => setMode("quick"));
    $("#tabAdvanced").addEventListener("click", () => setMode("advanced"));

    $("#btnAddGroup").addEventListener("click", addShell);
    $("#btnAddPoly").addEventListener("click", addPolyline);
    $("#btnGenerateOffset").addEventListener("click", generateOffset);
    $("#btnQuickGenerate").addEventListener("click", onGenerateShell);
    $("#btnSymW").addEventListener("click", symmetricFromW);
    $("#btnRegenAll").addEventListener("click", onRegenerateAll);
    $("#btnExportDxf").addEventListener("click", doExportDxf);
    $("#btnExportJson").addEventListener("click", doExportJson);
    $("#btnNewProject").addEventListener("click", newDefaultProject);
    $("#btnLoadSample").addEventListener("click", loadSample);
    $("#btnFitView").addEventListener("click", fitView);
    $("#showElevLabels").addEventListener("change", renderPreview);
    $("#showAllGroups").addEventListener("change", renderPreview);
    $("#showAxis").addEventListener("change", renderPreview);
    $("#btnImportJson").addEventListener("click", () => $("#fileImport").click());
    $("#fileImport").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) doImportJson(f);
      e.target.value = "";
    });
    $("#projectName").addEventListener("change", (e) => {
      project.name = e.target.value;
      renderValidation();
    });
    $("#projectUnits").addEventListener("change", (e) => {
      project.units = e.target.value;
    });

    for (const [id] of AXIS_FIELDS) {
      $("#" + id).addEventListener("input", onAxisInput);
    }
    for (const [id, , kind] of QM_FIELDS) {
      $("#" + id).addEventListener(kind === "bool" ? "change" : "input", onQuickFieldInput);
    }

    $("#inclMode").addEventListener("change", () => {
      const hv = $("#inclMode").value === "hv";
      $("#hvFields").style.display = hv ? "" : "none";
      $("#slopeField").style.display = hv ? "none" : "";
    });
    const updateHint = () => {
      const z0 = Number($("#refElev").value);
      const z = Number($("#targetElev").value);
      let slope;
      if ($("#inclMode").value === "hv") {
        const H = Number($("#inclH").value);
        const V = Number($("#inclV").value);
        slope = V === 0 ? NaN : H / V;
      } else slope = Number($("#inclSlope").value);
      const d = planOffsetDistance(z0, z, slope);
      if (isFinite(d)) {
        $("#offsetPreviewHint").textContent =
          `Preview: plan offset = |${z} − ${z0}| × ${round6(slope)} = ${round6(d)}`;
      }
    };
    ["refElev", "targetElev", "inclH", "inclV", "inclSlope", "inclMode"].forEach((id) => {
      $("#" + id).addEventListener("input", updateHint);
      $("#" + id).addEventListener("change", updateHint);
    });

    window.addEventListener("resize", () => renderPreview());
  }

  window.ReservoirWallApp = {
    ...api,
    getProject: () => project,
    setProject: (p) => {
      project = normalizeProject(p);
      selectedGroupId = project.groups[0]?.id || null;
      selectedPolyId = null;
      renderAll();
      fitView();
    },
  };

  // ---------- Init ----------
  bind();
  setMode("quick");
  renderAll();
  fitView();
  onAxisInput();
})();
