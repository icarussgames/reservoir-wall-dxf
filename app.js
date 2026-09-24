/**
 * Reservoir Wall DXF — Civil 3D Helper
 *
 * Quick Mode axis geometry (exact for 2-point segment):
 *   Looking from upstream (middle of lake): leftmost / rightmost UTM points.
 *   Axis direction d = normalize(rightmost - leftmost)
 *   n = (-d.y, d.x)  // CCW-left when walking leftmost→rightmost
 *   From the lake looking at the wall (leftmost on your left, rightmost on your
 *   right): the lake is on the near side of the crest. In plan with the axis
 *   drawn L→R, that near/lake side is −n (screen "below" for a typical E-W wall).
 *   Crest US (lake / aguas arriba) edge:  P + n*(-W/2)
 *   Crest DS (dry / aguas abajo) edge:    P + n*(+W/2)
 *   US toe = further −n by |ΔZ|*(H/V)
 *   DS toe = further +n by |ΔZ|*(H/V)
 */

(() => {
  "use strict";

  const GROUP_COLORS = [
    "#3b9eff", "#3ecf8e", "#f0b429", "#f07178",
    "#c792ea", "#89ddff", "#ffcb6b", "#82aaff",
  ];
  const DXF_COLORS = [5, 3, 2, 1, 6, 4, 30, 150];

  /** @type {{ name: string, units: string, groups: Group[], quickAxis?: {p0:{x:number,y:number}, p1:{x:number,y:number}} }} */
  let project = emptyProject();
  let selectedGroupId = null;
  let selectedPolyId = null;
  let view = { cx: 0, cy: 0, scale: 1 };
  /** Preview-only axis from last Quick Mode generate (also stored on project.quickAxis). */
  let previewAxis = null;

  /**
   * @typedef {{ id: string, name: string, color: string, dxfColor: number, polylines: Polyline[] }} Group
   * @typedef {{ id: string, name: string, elevation: number, closed: boolean, vertices: {x:number,y:number}[] }} Polyline
   */

  function uid(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 10);
  }

  function emptyProject() {
    return { name: "Untitled", units: "meters", groups: [] };
  }

  function sanitizeLayerName(name) {
    return String(name || "LAYER")
      .replace(/[<>\/\\":;?*|=`']/g, "_")
      .replace(/\s+/g, "_")
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
    const n = { x: -d.y, y: d.x }; // CCW-left; upstream = −n
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

  function makePoly(name, elevation, vertices, closed) {
    return {
      id: uid("p"),
      name,
      elevation: Number(elevation),
      closed: !!closed,
      vertices: (vertices || []).map((v) => ({ x: v.x, y: v.y })),
    };
  }

  function makeGroup(name, colorIdx, polylines) {
    const i = colorIdx % GROUP_COLORS.length;
    return {
      id: uid("g"),
      name,
      color: GROUP_COLORS[i],
      dxfColor: DXF_COLORS[i],
      polylines: polylines || [],
    };
  }

  // ---------- Quick Mode generation ----------

  /**
   * Build project groups from Quick Mode parameters.
   * @param {object} p
   * @returns {{ project: object, hint: string, axis: {p0,p1} }}
   */
  function buildQuickModeProject(p) {
    const leftmost = { x: Number(p.leftE), y: Number(p.leftN) };
    const rightmost = { x: Number(p.rightE), y: Number(p.rightN) };
    const W = Number(p.width);
    const zCrest = Number(p.zCrest);

    if (![leftmost.x, leftmost.y, rightmost.x, rightmost.y, W, zCrest].every(isFinite)) {
      throw new Error("All axis / crest fields must be numeric.");
    }
    if (W <= 0) throw new Error("Crest width W must be > 0.");

    const frame = axisFrame(leftmost, rightmost);
    if (!frame) throw new Error("Leftmost and rightmost points must be distinct.");

    const { n } = frame;
    const half = W / 2;

    // Crest borders — exact AutoCAD-style OFFSET of 2-pt segment
    // From lake looking at wall: US (aguas arriba) = −n, DS (aguas abajo) = +n
    const crestUS = offsetSegment(leftmost, rightmost, n, -half);  // lake-side crest edge
    const crestDS = offsetSegment(leftmost, rightmost, n, +half);  // dry-side crest edge

    // Upstream toe
    const usH = Number(p.usH);
    const usV = Number(p.usV);
    if (!isFinite(usH) || !isFinite(usV) || usV === 0) {
      throw new Error("Upstream H:V invalid (V ≠ 0).");
    }
    const usSlope = usH / usV;
    let usZToe = Number(p.usZToe);
    if (p.usUseDz) {
      const dz = Number(p.usDz);
      if (!isFinite(dz) || dz < 0) throw new Error("Upstream ΔZ must be ≥ 0.");
      usZToe = zCrest - dz;
    }
    if (!isFinite(usZToe)) throw new Error("Upstream toe elevation invalid.");
    const usRun = planOffsetDistance(zCrest, usZToe, usSlope);
    // Outward from lake-side crest = further −n
    const usToe = offsetSegment(leftmost, rightmost, n, -(half + usRun));

    // Downstream toe
    const dsH = Number(p.dsH);
    const dsV = Number(p.dsV);
    if (!isFinite(dsH) || !isFinite(dsV) || dsV === 0) {
      throw new Error("Downstream H:V invalid (V ≠ 0).");
    }
    const dsSlope = dsH / dsV;
    let dsZToe = Number(p.dsZToe);
    if (p.dsUseDz) {
      const dz = Number(p.dsDz);
      if (!isFinite(dz) || dz < 0) throw new Error("Downstream ΔZ must be ≥ 0.");
      dsZToe = zCrest - dz;
    }
    if (!isFinite(dsZToe)) throw new Error("Downstream toe elevation invalid.");
    const dsRun = planOffsetDistance(zCrest, dsZToe, dsSlope);
    // Outward from dry-side crest = further +n
    const dsToe = offsetSegment(leftmost, rightmost, n, +(half + dsRun));

    // CAD layers = material shells. Outer envelope lines share one layer.
    const groups = [];
    const outerPolys = [
      makePoly("Crest US edge (lake)", zCrest, crestUS, false),
      makePoly("Crest DS edge (dry)", zCrest, crestDS, false),
      makePoly("US toe", usZToe, usToe, false),
      makePoly("DS toe", dsZToe, dsToe, false),
    ];
    groups.push(makeGroup("outer shell", 0, outerPolys));

    let coreNote = "";
    if (p.coreEnable) {
      let coreHalf;
      if (p.coreMode === "hv") {
        const cH = Number(p.coreH);
        const cV = Number(p.coreV);
        const cZ = Number(p.coreZBase);
        if (!isFinite(cH) || !isFinite(cV) || cV === 0) {
          throw new Error("Core H:V invalid.");
        }
        if (!isFinite(cZ)) throw new Error("Core base elevation invalid.");
        coreHalf = planOffsetDistance(zCrest, cZ, cH / cV);
        const coreUS = offsetSegment(leftmost, rightmost, n, -coreHalf);
        const coreDS = offsetSegment(leftmost, rightmost, n, +coreHalf);
        groups.push(
          makeGroup("core", 1, [
            makePoly("Core crest US (lake)", zCrest, coreUS, false),
            makePoly("Core crest DS (dry)", zCrest, coreDS, false),
            makePoly("Core axis (base ref)", cZ, [leftmost, rightmost], false),
          ])
        );
        coreNote = ` Core half-width=${round6(coreHalf)} (H:V).`;
      } else {
        const Wc = Number(p.coreWidth);
        if (!isFinite(Wc) || Wc <= 0) throw new Error("Core width must be > 0.");
        if (Wc >= W) throw new Error("Core width should be narrower than crest W.");
        coreHalf = Wc / 2;
        const coreUS = offsetSegment(leftmost, rightmost, n, -coreHalf);
        const coreDS = offsetSegment(leftmost, rightmost, n, +coreHalf);
        groups.push(
          makeGroup("core", 1, [
            makePoly("Core crest US (lake)", zCrest, coreUS, false),
            makePoly("Core crest DS (dry)", zCrest, coreDS, false),
          ])
        );
        coreNote = ` Core width=${round6(Wc)}.`;
      }
    }

    const hint =
      `Axis len=${round6(frame.len)} m · W/2=${round6(half)} · ` +
      `US run=${round6(usRun)} (Z ${zCrest}→${usZToe}, ${round6(usSlope)}:1) · ` +
      `DS run=${round6(dsRun)} (Z ${zCrest}→${dsZToe}, ${round6(dsSlope)}:1).` +
      coreNote +
      ` US=lake(−n), DS=dry(+n). Axis: leftmost→rightmost (from upstream).`;

    return {
      project: {
        name: p.projectName || "Reservoir Wall Quick",
        units: p.units || "meters (UTM)",
        groups,
        quickAxis: {
          leftmost: { ...leftmost },
          rightmost: { ...rightmost },
          // legacy aliases for older JSON
          p0: { ...leftmost },
          p1: { ...rightmost },
        },
      },
      hint,
      axis: { leftmost, rightmost, p0: leftmost, p1: rightmost },
    };
  }

  function readQuickModeParams() {
    return {
      leftE: $("#qmLeftE").value,
      leftN: $("#qmLeftN").value,
      rightE: $("#qmRightE").value,
      rightN: $("#qmRightN").value,
      width: $("#qmWidth").value,
      zCrest: $("#qmZCrest").value,
      usH: $("#qmUsH").value,
      usV: $("#qmUsV").value,
      usZToe: $("#qmUsZToe").value,
      usUseDz: $("#qmUsUseDz").checked,
      usDz: $("#qmUsDz").value,
      dsH: $("#qmDsH").value,
      dsV: $("#qmDsV").value,
      dsZToe: $("#qmDsZToe").value,
      dsUseDz: $("#qmDsUseDz").checked,
      dsDz: $("#qmDsDz").value,
      coreEnable: $("#qmCoreEnable").checked,
      coreMode: $("#qmCoreMode").value,
      coreWidth: $("#qmCoreWidth").value,
      coreH: $("#qmCoreH").value,
      coreV: $("#qmCoreV").value,
      coreZBase: $("#qmCoreZBase").value,
      projectName: $("#projectName").value,
      units: $("#projectUnits").value,
    };
  }

  function applyQuickMode(opts) {
    const skipConfirm = opts && opts.skipConfirm;
    const hasContent =
      project.groups.length > 0 &&
      project.groups.some((g) => g.polylines && g.polylines.length);
    if (hasContent && !skipConfirm) {
      if (!confirm("Replace current project polylines with Quick Mode result?")) {
        return false;
      }
    }
    try {
      const built = buildQuickModeProject(readQuickModeParams());
      project = built.project;
      previewAxis = built.axis;
      selectedGroupId = project.groups[0]?.id || null;
      selectedPolyId = project.groups[0]?.polylines?.[0]?.id || null;
      $("#qmHint").textContent = built.hint;
      renderAll();
      fitView();
      toast("Quick Mode wall generated.", "ok");
      return true;
    } catch (err) {
      toast(err.message || String(err), "error");
      return false;
    }
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
        push(38, Number(pl.elevation) || 0);
        push(90, pl.vertices.length);
        push(70, pl.closed ? 1 : 0);
        for (const v of pl.vertices) {
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
        issues.push({ level: "error", msg: "A group has an empty name." });
      } else {
        const key = sanitizeLayerName(g.name).toLowerCase();
        if (groupNames.has(key)) {
          issues.push({ level: "warn", msg: `Duplicate layer name after sanitize: "${g.name}"` });
        }
        groupNames.add(key);
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
    }
    return issues;
  }

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);

  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show " + (kind || "ok");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function selectedGroup() {
    return project.groups.find((g) => g.id === selectedGroupId) || null;
  }

  function selectedPoly() {
    const g = selectedGroup();
    if (!g) return null;
    return g.polylines.find((p) => p.id === selectedPolyId) || null;
  }

  function setMode(mode) {
    const quick = mode === "quick";
    $("#tabQuick").classList.toggle("active", quick);
    $("#tabAdvanced").classList.toggle("active", !quick);
    $("#panelQuick").hidden = !quick;
    $("#panelAdvanced").hidden = quick;
  }

  // ---------- Render ----------
  function renderAll() {
    $("#projectName").value = project.name;
    $("#projectUnits").value = project.units || "meters";
    if (project.quickAxis) previewAxis = project.quickAxis;
    renderGroups();
    renderPolys();
    renderPolyDetail();
    renderPreview();
    renderValidation();
  }

  function renderGroups() {
    const ul = $("#groupList");
    ul.innerHTML = "";
    if (!project.groups.length) {
      ul.innerHTML = '<li class="empty">No shells yet. Use Quick Mode or Add.</li>';
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
          if (confirm(`Delete group "${g.name}" and all its polylines?`)) {
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
        selectedPolyId = g.polylines[0]?.id || null;
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
      ul.innerHTML = '<li class="empty">Select a group.</li>';
      return;
    }
    if (!g.polylines.length) {
      ul.innerHTML = '<li class="empty">No polylines. Add one or use Quick Mode.</li>';
      return;
    }
    g.polylines.forEach((pl) => {
      const li = document.createElement("li");
      li.className = "list-item" + (pl.id === selectedPolyId ? " active" : "");
      li.innerHTML = `
        <span class="name">${escapeHtml(pl.name)}</span>
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
            if (selectedPolyId === pl.id) selectedPolyId = g.polylines[0]?.id || null;
            renderAll();
          }
          return;
        }
        selectedPolyId = pl.id;
        renderAll();
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
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    for (const { poly } of items) {
      for (const v of poly.vertices) consider(v.x, v.y);
    }
    if (previewAxis) {
      const a0 = previewAxis.leftmost || previewAxis.p0;
      const a1 = previewAxis.rightmost || previewAxis.p1;
      if (a0) consider(a0.x, a0.y);
      if (a1) consider(a1.x, a1.y);
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
    const showAxis = $("#showAxis") ? $("#showAxis").checked : true;
    const items = allVisiblePolys();

    let html = `<rect x="0" y="0" width="${w}" height="${h}" fill="#0a0e14"/>`;

    // Axis (dashed) under polylines — leftmost → rightmost
    if (showAxis && previewAxis) {
      const ax0 = previewAxis.leftmost || previewAxis.p0;
      const ax1 = previewAxis.rightmost || previewAxis.p1;
      if (ax0 && ax1) {
        const a = worldToSvg(ax0.x, ax0.y, w, h);
        const b = worldToSvg(ax1.x, ax1.y, w, h);
        html += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#8b9bb4" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.9"/>`;
        html += `<circle cx="${a.x}" cy="${a.y}" r="3.5" fill="#8b9bb4"/>`;
        html += `<circle cx="${b.x}" cy="${b.y}" r="3.5" fill="#8b9bb4"/>`;
        html += `<text x="${a.x + 6}" y="${a.y - 8}" fill="#8b9bb4" font-size="10" font-family="system-ui">Leftmost</text>`;
        html += `<text x="${b.x + 6}" y="${b.y - 8}" fill="#8b9bb4" font-size="10" font-family="system-ui">Rightmost</text>`;
        html += `<text x="10" y="18" fill="#3b9eff" font-size="11" font-family="system-ui">US = lake / aguas arriba (−n)</text>`;
        html += `<text x="10" y="34" fill="#f0b429" font-size="11" font-family="system-ui">DS = dry / aguas abajo (+n)</text>`;
      }
    }

    for (const { group, poly } of items) {
      const pts = poly.vertices.map((v) => worldToSvg(v.x, v.y, w, h));
      if (pts.length < 1) continue;
      let d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      if (poly.closed && pts.length > 2) d += " Z";
      const isSel = poly.id === selectedPolyId;
      html += `<path d="${d}" fill="none" stroke="${group.color}" stroke-width="${isSel ? 2.5 : 1.5}" opacity="${isSel ? 1 : 0.8}"/>`;
      for (const p of pts) {
        html += `<circle cx="${p.x}" cy="${p.y}" r="${isSel ? 3.5 : 2}" fill="${group.color}"/>`;
      }
      if (showLabels && pts.length) {
        const mid = pts[Math.floor(pts.length / 2)];
        html += `<text x="${mid.x + 6}" y="${mid.y - 6}" fill="${group.color}" font-size="11" font-family="system-ui">${escapeHtml(String(poly.elevation))}</text>`;
      }
    }

    svg.innerHTML = html;
  }

  // ---------- Actions ----------
  function addGroup() {
    const n = prompt("New shell / CAD layer name:", "filter");
    if (n == null || !n.trim()) return;
    const g = makeGroup(n.trim(), project.groups.length, []);
    project.groups.push(g);
    selectedGroupId = g.id;
    selectedPolyId = null;
    renderAll();
  }

  function addPolyline() {
    const g = selectedGroup();
    if (!g) { toast("Select or create a group first.", "warn"); return; }
    const pl = makePoly("Polyline " + (g.polylines.length + 1), 0, [
      { x: 0, y: 0 }, { x: 10, y: 0 },
    ]);
    g.polylines.push(pl);
    selectedPolyId = pl.id;
    renderAll();
  }

  function generateOffset() {
    const g = selectedGroup();
    if (!g) { toast("Select a group first.", "warn"); return; }
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
    if (warns.length) toast(`${warns.length} warning(s) — exporting anyway.`, "warn");
    downloadText(
      sanitizeLayerName(project.name || "project") + ".dxf",
      exportDxf(project),
      "application/dxf"
    );
    toast("DXF downloaded.", "ok");
  }

  function doExportJson() {
    downloadText(
      sanitizeLayerName(project.name || "project") + ".json",
      JSON.stringify(project, null, 2),
      "application/json"
    );
    toast("JSON exported.", "ok");
  }

  function doImportJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.groups)) throw new Error("Invalid project JSON");
        project = data;
        project.groups.forEach((g, i) => {
          if (!g.id) g.id = uid("g");
          if (!g.color) g.color = GROUP_COLORS[i % GROUP_COLORS.length];
          if (!g.dxfColor) g.dxfColor = DXF_COLORS[i % DXF_COLORS.length];
          (g.polylines || []).forEach((p) => {
            if (!p.id) p.id = uid("p");
            if (!Array.isArray(p.vertices)) p.vertices = [];
          });
        });
        previewAxis = project.quickAxis || null;
        selectedGroupId = project.groups[0]?.id || null;
        selectedPolyId = project.groups[0]?.polylines?.[0]?.id || null;
        renderAll();
        fitView();
        toast("Project imported.", "ok");
      } catch (err) {
        toast("Import failed: " + err.message, "error");
      }
    };
    reader.readAsText(file);
  }

  function loadSample() {
    project = sampleProject();
    previewAxis = null;
    selectedGroupId = project.groups[0].id;
    selectedPolyId = project.groups[0].polylines[0].id;
    $("#baselinePts").value = "0, 0\n40, 2\n80, 0\n120, -3\n160, 0";
    $("#refElev").value = "100";
    $("#projectName").value = project.name;
    $("#projectUnits").value = project.units;
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

  function syncQmDzUi() {
    $("#qmUsDzWrap").style.display = $("#qmUsUseDz").checked ? "" : "none";
    $("#qmDsDzWrap").style.display = $("#qmDsUseDz").checked ? "" : "none";
  }

  function syncQmCoreUi() {
    const on = $("#qmCoreEnable").checked;
    $("#qmCoreFields").style.display = on ? "" : "none";
    const hv = $("#qmCoreMode").value === "hv";
    $("#qmCoreWidthRow").style.display = hv ? "none" : "";
    $("#qmCoreHvRow").style.display = hv ? "" : "none";
  }

  function updateQmLiveHint() {
    try {
      const built = buildQuickModeProject(readQuickModeParams());
      $("#qmHint").textContent = "Preview: " + built.hint;
    } catch (err) {
      $("#qmHint").textContent = err.message || "";
    }
  }

  // ---------- Wire UI ----------
  function bind() {
    $("#tabQuick").addEventListener("click", () => setMode("quick"));
    $("#tabAdvanced").addEventListener("click", () => setMode("advanced"));

    $("#btnAddGroup").addEventListener("click", addGroup);
    $("#btnAddPoly").addEventListener("click", addPolyline);
    $("#btnGenerateOffset").addEventListener("click", generateOffset);
    $("#btnQuickGenerate").addEventListener("click", () => applyQuickMode({ skipConfirm: false }));
    $("#btnExportDxf").addEventListener("click", doExportDxf);
    $("#btnExportJson").addEventListener("click", doExportJson);
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
    $("#inclMode").addEventListener("change", () => {
      const hv = $("#inclMode").value === "hv";
      $("#hvFields").style.display = hv ? "" : "none";
      $("#slopeField").style.display = hv ? "none" : "";
    });

    $("#qmUsUseDz").addEventListener("change", syncQmDzUi);
    $("#qmDsUseDz").addEventListener("change", syncQmDzUi);
    $("#qmCoreEnable").addEventListener("change", syncQmCoreUi);
    $("#qmCoreMode").addEventListener("change", syncQmCoreUi);

    const qmIds = [
      "qmLeftE", "qmLeftN", "qmRightE", "qmRightN", "qmWidth", "qmZCrest",
      "qmUsH", "qmUsV", "qmUsZToe", "qmUsDz",
      "qmDsH", "qmDsV", "qmDsZToe", "qmDsDz",
      "qmCoreWidth", "qmCoreH", "qmCoreV", "qmCoreZBase",
    ];
    qmIds.forEach((id) => {
      const el = $("#" + id);
      if (el) {
        el.addEventListener("input", updateQmLiveHint);
        el.addEventListener("change", updateQmLiveHint);
      }
    });
    ["qmUsUseDz", "qmDsUseDz", "qmCoreEnable", "qmCoreMode"].forEach((id) => {
      $("#" + id).addEventListener("change", updateQmLiveHint);
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
    exportDxf,
    sampleProject,
    buildQuickModeProject,
    offsetPolylineFromBaseline,
    offsetSegment,
    axisFrame,
    planOffsetDistance,
    sanitizeLayerName,
    validateProject,
    getProject: () => project,
    setProject: (p) => {
      project = p;
      previewAxis = p.quickAxis || null;
      selectedGroupId = p.groups[0]?.id || null;
      selectedPolyId = p.groups[0]?.polylines?.[0]?.id || null;
      renderAll();
    },
  };

  // ---------- Init ----------
  bind();
  syncQmDzUi();
  syncQmCoreUi();
  setMode("quick");
  // Enable core in presets for a richer default demo, then generate
  $("#qmCoreEnable").checked = true;
  syncQmCoreUi();
  applyQuickMode({ skipConfirm: true });
  updateQmLiveHint();
})();
