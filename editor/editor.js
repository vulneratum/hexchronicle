/*
 * HexChronicle editor client.
 *   Phase 1 — terrain paint brush + Save.
 *   Phase 2 — line tools: draw/extend/reroute/retype/delete rivers & roads.
 *   Phase 3 — the atlas: every plate on one canvas, add-new-plate flow.
 *
 * NAVIGATION IS A SLIPPY MAP. The active plate always sits at world origin
 * (0,0); every editing coordinate (paint, lines, undo, save) depends on that.
 * Switching plates RE-ORIGINS the atlas rather than moving the active plate, so
 * zoom, camera, and the detail cache survive — no page reload.
 *
 * LOD + culling keep the node count bounded: off-screen plates are neither
 * fetched nor built; on-screen plates draw as flat colour below DETAIL_ZOOM and
 * as a full subhex grid (up to MAX_FULL nearest) above it.
 *
 * SVG click caveat: pointerdown calls preventDefault() + setPointerCapture,
 * which suppresses the `click` event for everything inside the map. All map
 * interaction routes through endPointer()'s hit test (atlasAt). Never add a
 * click listener to an SVG element.
 *
 * Draws with the shared PlateDraw core; adds the editing interaction here.
 */
(function () {
  "use strict";
  const { SIZE, RL, SQ3, pxToAxial } = HexGeo;
  const svg = document.getElementById("map");
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const el = PlateDraw.el;

  /* ---- tuning ---- */
  const PAD_LEFT = 215;                 // canvas taken by the left-hand panel
  const DETAIL_ZOOM = 0.40;             // context plates gain subhex detail above this scale
  const MAX_FULL = 14;                  // cap on simultaneously-detailed context plates (node budget)
  const CULL_MARGIN = RL * 0.6;         // build slightly beyond the viewport so panning doesn't pop
  const FADE_MS = 220;                  // LOD cross-fade duration
  const LABEL_Y = -(RL - SIZE * 0.55);  // plate-id label sits at the plate's top
  const DIR_NAME = { e: "east", ne: "north-east", nw: "north-west", w: "west", sw: "south-west", se: "south-east" };
  const DIR_AXIAL = { e: [1, 0], se: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [0, -1], ne: [1, -1] };
  const plateToPx = (q, r) => ({ x: SQ3 * RL * (q + r / 2), y: 1.5 * RL * r });

  /* ---- active-plate state (rebuilt on every switch) ---- */
  let model, geo, byKey, pd, plateId, defaultTerrain;
  let gEdit = null;                     // overlay group for the in-progress line
  let brush;                            // terrain brush
  let workingLines = [];                // [{type, path:[sub]}] — source of truth for the active plate's lines
  let lineType = null, editing = null;
  let dirtyTerrain = false, dirtyLines = false;
  const undoStack = [], redoStack = [];
  let curStroke = null;

  /* ---- atlas / camera state (persists across switches) ---- */
  let camera = null, gAtlas = null;     // camera holds pan/zoom; gAtlas holds context plates + slots
  let atlas = null;                     // last atlas payload (for profiles etc.)
  let atlasIndex = [], slotIndex = [];  // world positions of every plate / empty slot
  const detailCache = new Map();        // id -> {default_terrain, terrain, lines, features}
  const fetching = new Set();           // detail fetches in flight
  const rendered = new Map();           // id -> { g, label, content, lod, x, y, entry } for built context plates
  const renderedSlots = new Map();      // key -> g for built slots

  let tool = "paint", spaceHeld = false;

  const QUERY_PLATE = new URLSearchParams(location.search).get("plate");

  getModel(QUERY_PLATE).then(init).catch(err => setStatus("load failed: " + err, "err"));

  function getModel(id) {
    return fetch("/api/model" + (id ? "?plate=" + encodeURIComponent(id) : ""))
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  function init(m) {
    geo = HexGeo.buildPlateHexes();
    byKey = new Map(geo.map(h => [h.key, h]));

    // camera group: everything the pan/zoom transform applies to. The active
    // plate is re-parented under it so the surrounding atlas moves with it,
    // while staying at world origin (see hexAt / the switching functions).
    camera = document.createElementNS(SVGNS, "g");
    gAtlas = document.createElementNS(SVGNS, "g");
    svg.appendChild(camera);
    camera.appendChild(gAtlas);         // context plates draw beneath the active plate

    mountActivePlate(m);
    wireTools();
    setStatus("ready");
    fitAll();                    // centre the active plate right away…
    refetchAtlas().then(fitAll); // …then reframe once the atlas is known
  }

  /*
   * Tear down the current active plate and build a new one from model `m`. Used
   * by init and by every in-place switch. Leaves camera/atlas untouched.
   */
  function mountActivePlate(m) {
    if (pd) pd.world.remove();
    model = m;
    plateId = m.plate.id;
    defaultTerrain = m.plate.default_terrain;
    model.geo = geo;
    $("plateId").textContent = plateId;
    document.title = `HexChronicle Editor — Plate ${plateId}`;

    pd = PlateDraw.create(svg, model);
    camera.appendChild(pd.world);        // move above gAtlas
    for (const c of pd.neighborChips) c.g.remove();   // full-size slots replace the per-plate chips
    gEdit = document.createElementNS(SVGNS, "g");
    pd.world.appendChild(gEdit);

    workingLines = (model.lines || []).map(l => ({ type: l.type, path: l.path.slice() }));
    editing = null; hideEditUI();
    undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
    dirtyTerrain = false; dirtyLines = false; $("save").disabled = true;

    buildPalette();
    buildLineTypes();
    renderLineList();
  }

  /* ---------- terrain palette (from theme registry) ---------- */
  function buildPalette() {
    const T = model.registry.terrain, box = $("swatches");
    box.textContent = "";
    for (const key of Object.keys(T)) {
      const b = document.createElement("div");
      b.className = "swatch";
      b.innerHTML = `<i style="background:${T[key].color}"></i><span>${T[key].label}</span><span class="key">${key}</span>`;
      b.dataset.key = key;
      b.addEventListener("click", () => selectBrush(key));
      box.appendChild(b);
    }
    // Starting the brush on the plate's default terrain makes Paint look broken
    // — every stroke a no-op until you pick another swatch. Start off-default.
    brush = Object.keys(T).find(k => k !== defaultTerrain) || defaultTerrain;
    selectBrush(brush);
  }
  function selectBrush(key) {
    brush = key;
    for (const b of document.querySelectorAll(".swatch")) b.classList.toggle("active", b.dataset.key === key);
  }

  /* ---------- line-type palette (from theme registry) ---------- */
  function buildLineTypes() {
    const L = model.registry.lines || {}, box = $("lineTypes");
    box.textContent = "";
    const keys = Object.keys(L);
    for (const key of keys) {
      const spec = L[key];
      const b = document.createElement("button");
      b.className = "ltype";
      b.dataset.key = key;
      b.innerHTML = `<i style="border-top-color:${spec.color};border-top-width:${Math.max(2, spec.width)}px;${spec.dash ? "border-top-style:dashed" : "border-top-style:solid"}"></i>${spec.label}`;
      b.addEventListener("click", () => selectLineType(key));
      box.appendChild(b);
    }
    lineType = keys.includes("road") ? "road" : keys[0];
    highlightLineType();
  }
  function highlightLineType() {
    for (const b of document.querySelectorAll(".ltype")) b.classList.toggle("active", b.dataset.key === lineType);
  }
  function selectLineType(key) {
    lineType = key;
    highlightLineType();
    if (editing) { editing.type = key; renderLines(); updateEditInfo(); }
  }

  /* ---------- pan / zoom ---------- */
  let s = 1, tx = 0, ty = 0;
  function applyTransform() {
    camera.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
    pd.setNumbersVisible(s >= 0.95);
    scheduleViewport();
  }
  function viewSize() { const r = svg.getBoundingClientRect(); return { w: r.width || innerWidth, h: r.height || innerHeight }; }
  /* Frame the whole atlas (every plate position), centred right of the panel. */
  function fitAll() {
    const v = viewSize();
    const pts = (atlasIndex && atlasIndex.length) ? atlasIndex : [{ x: 0, y: 0 }];
    const minX = Math.min(...pts.map(p => p.x)) - RL - SIZE, maxX = Math.max(...pts.map(p => p.x)) + RL + SIZE;
    const minY = Math.min(...pts.map(p => p.y)) - RL - SIZE, maxY = Math.max(...pts.map(p => p.y)) + RL + SIZE;
    const availW = Math.max(200, v.w - PAD_LEFT - 40), availH = Math.max(200, v.h - 110);
    s = Math.min(3, Math.max(0.05, Math.min(availW / (maxX - minX), availH / (maxY - minY))));
    tx = PAD_LEFT + availW / 2 - ((minX + maxX) / 2) * s;
    ty = 70 + availH / 2 - ((minY + maxY) / 2) * s;
    applyTransform();
  }
  window.addEventListener("resize", () => fitAll());
  function zoomAt(cx, cy, k) {
    const ns = Math.min(3.2, Math.max(0.05, s * k)), real = ns / s;
    tx = cx - (cx - tx) * real; ty = cy - (cy - ty) * real; s = ns;
    applyTransform();
  }

  // client -> active-plate subhex. Works because the active plate is at origin.
  function hexAt(clientX, clientY) {
    const a = pxToAxial((clientX - tx) / s, (clientY - ty) / s);
    return byKey.get(a.q + "," + a.r) || null;
  }

  /* ---------- terrain painting ---------- */
  function paintAt(cx, cy) {
    const h = hexAt(cx, cy);
    if (!h) return;
    const from = model.terrainByNum[h.sub];
    if (from === brush) return;
    if (!(h.sub in curStroke)) curStroke[h.sub] = { sub: h.sub, from };
    curStroke[h.sub].to = brush;
    pd.setTerrain(h.sub, brush);
    markTerrainDirty();
  }

  /* ---------- line editing ---------- */
  function visibleLines() {
    return (editing && editing.orig != null) ? workingLines.filter((_, i) => i !== editing.orig) : workingLines;
  }
  function renderLines() { pd.rebuildLines(visibleLines()); drawActive(); }

  function drawActive() {
    gEdit.textContent = "";
    if (!editing || !editing.path.length) return;
    const pts = editing.path.map(sub => pd.hexBySub.get(sub)).filter(Boolean);
    const st = pd.lineStyle(editing.type);
    if (pts.length >= 2) {
      const d = "M " + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
      el("path", { d, fill: "none", stroke: st.color, "stroke-width": st.width, "stroke-linecap": "round", opacity: "0.55" }, gEdit);
      el("path", { d, fill: "none", stroke: "#f3ead0", "stroke-width": "1.4", "stroke-dasharray": "4 4", "stroke-linecap": "round" }, gEdit);
    }
    pts.forEach((p, i) => {
      el("circle", { cx: p.x, cy: p.y, r: i === 0 || i === pts.length - 1 ? 4 : 2.6, fill: "#f3ead0", stroke: "#2b2b23", "stroke-width": "1.2" }, gEdit);
    });
  }

  function startNewLine() {
    editing = { orig: null, type: lineType, path: [] };
    showEditUI(); renderLineList(); renderLines(); updateEditInfo();
    setStatus("drawing a new " + lineLabel(lineType) + " — click hexes");
  }
  function selectLine(i) {
    editing = { orig: i, type: workingLines[i].type, path: workingLines[i].path.slice() };
    lineType = editing.type; highlightLineType();
    showEditUI(); renderLineList(); renderLines(); updateEditInfo();
    setStatus("editing " + lineLabel(editing.type) + " · click to extend, Backspace to trim");
  }
  function lineTap(cx, cy) {
    const h = hexAt(cx, cy);
    if (!h) return;
    if (!editing) {
      const i = workingLines.findIndex(l => l.path.includes(h.sub));
      if (i >= 0) selectLine(i);
      return;
    }
    if (editing.path[editing.path.length - 1] === h.sub) return;   // ignore repeat
    editing.path.push(h.sub);
    renderLines(); updateEditInfo();
  }
  function trimLast() { if (editing && editing.path.length) { editing.path.pop(); renderLines(); updateEditInfo(); } }

  function finishLine() {
    if (!editing) return;
    if (editing.path.length < 2) { setStatus("a line needs at least 2 hexes", "err"); return; }
    const rec = { type: editing.type, path: editing.path.slice() };
    if (editing.orig == null) workingLines.push(rec); else workingLines[editing.orig] = rec;
    editing = null; markLinesDirty(); hideEditUI(); renderLineList(); renderLines();
    setStatus("line set — Save to write it to disk");
  }
  function cancelLine() { editing = null; hideEditUI(); renderLineList(); renderLines(); setStatus("edit cancelled"); }
  function deleteLine() {
    if (!editing || editing.orig == null) return;
    workingLines.splice(editing.orig, 1);
    editing = null; markLinesDirty(); hideEditUI(); renderLineList(); renderLines();
    setStatus("line deleted — Save to write it to disk");
  }

  function lineLabel(type) { const L = model.registry.lines[type]; return L ? L.label : type; }
  function showEditUI() { $("lineEdit").hidden = false; $("lineIdleHint").hidden = true; $("deleteLine").hidden = editing.orig == null; updateEditInfo(); }
  function hideEditUI() { $("lineEdit").hidden = true; $("lineIdleHint").hidden = false; }
  function updateEditInfo() {
    if (!editing) return;
    const verb = editing.orig == null ? "New" : "Editing";
    $("editInfo").textContent = `${verb} ${lineLabel(editing.type)} · ${editing.path.length} hex${editing.path.length === 1 ? "" : "es"}`;
  }
  function renderLineList() {
    const box = $("lineList"); box.textContent = "";
    if (!workingLines.length) { box.innerHTML = `<div class="lineitem"><span class="empty">No lines yet.</span></div>`; return; }
    workingLines.forEach((l, i) => {
      const spec = model.registry.lines[l.type] || { color: "#888", width: 2, label: l.type };
      const it = document.createElement("div");
      it.className = "lineitem" + (editing && editing.orig === i ? " active" : "");
      it.innerHTML = `<i style="border-top-color:${spec.color};border-top-width:${Math.max(2, spec.width)}px;border-top-style:${spec.dash ? "dashed" : "solid"}"></i><span>${spec.label}</span><span class="n">${l.path.length} hex</span>`;
      it.addEventListener("click", () => selectLine(i));
      box.appendChild(it);
    });
  }

  /* ============================================================= *
   * The atlas: LOD + viewport culling + detail cache
   * ============================================================= */
  function terrainColor(type) {
    return ((model.registry.terrain || {})[type] || {}).color || "#cccccc";
  }
  function smoothPath(pts) {
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const L = pts[pts.length - 1];
    return d + ` L ${L.x.toFixed(1)} ${L.y.toFixed(1)}`;
  }

  /* index every plate + slot at its world position (active plate at 0,0) */
  function loadAtlas(a) {
    atlas = a;
    atlasIndex = a.plates.map(p => {
      const o = plateToPx(p.coord[0], p.coord[1]);
      return { kind: "plate", id: p.id, name: p.name, continent_hex: p.continent_hex, default_terrain: p.default_terrain, x: o.x, y: o.y };
    });
    slotIndex = a.empty.map(t => {
      const o = plateToPx(t.coord[0], t.coord[1]);
      return { kind: "slot", from: t.from, dir: t.dir, x: o.x, y: o.y };
    });
    // positions changed wholesale — drop every built group and let the viewport
    // pass rebuild only what is on screen.
    for (const id of [...rendered.keys()]) removeRendered(id);
    for (const [, g] of renderedSlots) g.remove();
    renderedSlots.clear();

    const problems = [];
    if (a.orphans && a.orphans.length) problems.push(`${a.orphans.length} plate(s) not linked to this map`);
    if (a.dangling && a.dangling.length) problems.push(`${a.dangling.length} neighbour link(s) point at a missing plate`);
    if (a.conflicts && a.conflicts.length) problems.push(`${a.conflicts.length} inconsistent neighbour link(s)`);
    if (problems.length) setStatus(problems.join(" · "), "err");

    updateViewport();
  }

  function refetchAtlas() {
    return fetch("/api/atlas?origin=" + encodeURIComponent(plateId))
      .then(r => r.json()).then(loadAtlas)
      .catch(() => setStatus("atlas failed to load", "err"));
  }

  /* re-origin the atlas so the (already-mounted) new active plate sits at 0,0 */
  function reorigin(wx, wy) {
    for (const e of atlasIndex) { e.x -= wx; e.y -= wy; }
    for (const t of slotIndex) { t.x -= wx; t.y -= wy; }
    for (const rec of rendered.values()) {
      rec.x -= wx; rec.y -= wy;
      rec.g.setAttribute("transform", `translate(${rec.x.toFixed(1)} ${rec.y.toFixed(1)})`);
    }
    for (const [, g] of renderedSlots) g.remove();     // slots are cheap; rebuilt by updateViewport
    renderedSlots.clear();
  }

  function viewportWorldRect() {
    const v = viewSize();
    return { xmin: (PAD_LEFT - tx) / s, xmax: (v.w - tx) / s, ymin: (0 - ty) / s, ymax: (v.h - ty) / s };
  }
  function inView(e, vp) {
    return e.x + RL + CULL_MARGIN > vp.xmin && e.x - RL - CULL_MARGIN < vp.xmax
        && e.y + RL + CULL_MARGIN > vp.ymin && e.y - RL - CULL_MARGIN < vp.ymax;
  }

  let vpScheduled = false;
  function scheduleViewport() {
    if (vpScheduled) return;
    vpScheduled = true;
    requestAnimationFrame(() => { vpScheduled = false; updateViewport(); });
  }

  /*
   * The heart of the slippy map: decide what is on screen, at what LOD, build
   * the deltas, tear down what left. Off-screen plates are never built and
   * their detail is never fetched, so node count stays bounded as the map grows.
   */
  function updateViewport() {
    if (!atlasIndex.length && !slotIndex.length) return;
    const vp = viewportWorldRect();
    const cx = (vp.xmin + vp.xmax) / 2, cy = (vp.ymin + vp.ymax) / 2;

    const vis = atlasIndex.filter(e => e.id !== plateId && inView(e, vp));

    // above DETAIL_ZOOM, the MAX_FULL nearest visible plates get full detail
    const detailIds = new Set();
    if (s >= DETAIL_ZOOM) {
      vis.map(e => ({ e, d: Math.hypot(e.x - cx, e.y - cy) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_FULL)
        .forEach(o => detailIds.add(o.e.id));
    }

    const want = new Set(vis.map(e => e.id));
    for (const id of [...rendered.keys()]) if (!want.has(id) || id === plateId) removeRendered(id);
    for (const e of vis) ensureRendered(e, detailIds.has(e.id) ? "detail" : "summary");

    const visSlots = slotIndex.filter(t => inView(t, vp));
    const wantSlots = new Set(visSlots.map(slotKey));
    for (const [k, g] of renderedSlots) if (!wantSlots.has(k)) { g.remove(); renderedSlots.delete(k); }
    for (const t of visSlots) ensureSlot(t);

    // counter-scale plate labels so they stay a constant size on screen
    const k = (1 / s).toFixed(4);
    for (const rec of rendered.values()) rec.label.setAttribute("transform", `translate(0 ${LABEL_Y}) scale(${k})`);
  }

  function removeRendered(id) {
    const rec = rendered.get(id);
    if (rec) { rec.g.remove(); rendered.delete(id); }
  }

  function ensureRendered(e, lod) {
    let rec = rendered.get(e.id);
    if (!rec) {
      const g = el("g", { transform: `translate(${e.x.toFixed(1)} ${e.y.toFixed(1)})`, style: "opacity:0.86" }, gAtlas);
      const label = el("text", { "text-anchor": "middle", "font-size": 30, "font-family": "'IM Fell English SC',serif", fill: "rgba(43,43,35,0.6)" }, g);
      label.textContent = `${e.id}${e.name ? " · " + e.name : ""}`;
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = `Go to plate ${e.id}${e.name ? " (" + e.name + ")" : ""}`;
      g.appendChild(title);
      rec = { g, label, content: null, lod: null, x: e.x, y: e.y, entry: e };
      rendered.set(e.id, rec);
    }
    if (lod === "detail") {
      const d = detailCache.get(e.id);
      if (d) setLod(rec, "detail", d);
      else { if (rec.lod !== "detail") setLod(rec, "summary"); requestDetail(e.id); }
    } else {
      setLod(rec, "summary");
    }
  }

  // cross-fade content so an LOD flip eases in rather than popping
  function setLod(rec, lod, detail) {
    if (rec.lod === lod) return;
    const old = rec.content;
    const fresh = el("g", { style: `opacity:0;transition:opacity ${FADE_MS}ms ease` });
    rec.g.insertBefore(fresh, rec.label);       // keep the label on top
    if (lod === "detail") renderDetailInto(fresh, rec.entry, detail);
    else renderSummaryInto(fresh, rec.entry);
    requestAnimationFrame(() => { fresh.style.opacity = "1"; });
    if (old) { old.style.transition = `opacity ${FADE_MS}ms ease`; old.style.opacity = "0"; setTimeout(() => old.remove(), FADE_MS + 40); }
    rec.content = fresh; rec.lod = lod;
  }

  function renderSummaryInto(g, e) {
    el("polygon", { points: HexGeo.plateCorners(RL + SIZE * 0.2), fill: terrainColor(e.default_terrain), stroke: "#3f5c56", "stroke-width": 3, "stroke-linejoin": "round" }, g);
  }
  function renderDetailInto(g, e, d) {
    for (const h of geo) {
      el("polygon", { points: HexGeo.hexCorners(h.x, h.y, SIZE), fill: terrainColor(d.terrain[h.sub] || d.default_terrain), stroke: "rgba(0,0,0,0.14)", "stroke-width": 1 }, g);
    }
    for (const ln of (d.lines || [])) {
      const pts = ln.path.map(sub => pd.hexBySub.get(sub)).filter(Boolean);
      if (pts.length < 2) continue;
      const st = pd.lineStyle(ln.type);
      const attrs = { d: smoothPath(pts), fill: "none", stroke: st.color, "stroke-width": st.width, "stroke-linecap": "round" };
      if (st.dash) attrs["stroke-dasharray"] = st.dash;
      el("path", attrs, g);
    }
    for (const [sub, c] of Object.entries(d.features || {})) {
      const h = pd.hexBySub.get(sub);
      if (h && c.feature) PlateDraw.drawIcon(g, c.feature.type, h.x, h.y, 1);
    }
    el("polygon", { points: HexGeo.plateCorners(RL + SIZE * 0.2), fill: "none", stroke: "#3f5c56", "stroke-width": 3, "stroke-linejoin": "round" }, g);
  }

  function requestDetail(id) {
    if (detailCache.has(id) || fetching.has(id)) return;
    fetching.add(id);
    fetch("/api/plate/" + id + "/detail")
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(d => { detailCache.set(id, d); fetching.delete(id); scheduleViewport(); })
      .catch(() => { fetching.delete(id); });
  }

  const slotKey = t => t.from + "|" + t.dir;
  function ensureSlot(t) {
    const key = slotKey(t);
    if (renderedSlots.has(key)) return;
    const g = el("g", { transform: `translate(${t.x.toFixed(1)} ${t.y.toFixed(1)})`, class: "slot" }, gAtlas);
    el("polygon", { points: HexGeo.plateCorners(RL - SIZE * 0.25), fill: "rgba(233,226,207,0.06)", stroke: "#4b6a63", "stroke-width": 4, "stroke-dasharray": "18 14", "stroke-linejoin": "round" }, g);
    const plus = el("text", { "text-anchor": "middle", y: 46, "font-size": 132, "font-weight": 700, "font-family": "'Alegreya Sans',sans-serif", fill: "#4b6a63" }, g);
    plus.textContent = "+";
    const cap = el("text", { "text-anchor": "middle", y: 104, "font-size": 30, "letter-spacing": "4", "font-family": "'IBM Plex Mono',monospace", fill: "#4b6a63" }, g);
    cap.textContent = "ADD 36-MI HEX";
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = `Add a new 36-mile hex ${DIR_NAME[t.dir]} of plate ${t.from}`;
    g.appendChild(title);
    renderedSlots.set(key, g);
  }

  /* hit-test in world coords (see the SVG-click caveat at the top) */
  function atlasAt(clientX, clientY) {
    const wx = (clientX - tx) / s, wy = (clientY - ty) / s;
    for (const t of slotIndex) if (HexGeo.insidePlate(wx - t.x, wy - t.y, RL)) return t;
    for (const e of atlasIndex) if (e.id !== plateId && HexGeo.insidePlate(wx - e.x, wy - e.y, RL)) return { kind: "plate", id: e.id };
    return null;
  }

  /* ---------- in-place plate switching (no reload) ---------- */
  function confirmLeave() {
    if (!dirtyTerrain && !dirtyLines) return true;
    return confirm(`Plate ${plateId} has unsaved changes that will be lost. Leave anyway?`);
  }

  async function gotoPlate(id) {
    if (id === plateId) return;
    if (!confirmLeave()) return;
    const e = atlasIndex.find(x => x.id === id);
    if (!e) { location.search = "?plate=" + encodeURIComponent(id); return; }   // not indexed: hard fallback
    const wx = e.x, wy = e.y;
    setStatus("loading plate " + id + "…");
    let m;
    try { m = await getModel(id); } catch (err) { setStatus("failed to load " + id + ": " + err.message, "err"); return; }
    mountActivePlate(m);
    reorigin(wx, wy);            // the new active plate is now at (0,0)…
    tx += wx * s; ty += wy * s;  // …and the camera is compensated so nothing moves
    applyTransform();
    updateViewport();
    setStatus("plate " + id + (m.plate.name ? " · " + m.plate.name : ""));
  }

  /* ---------- add-new-plate flow ---------- */
  let addDir = null, addFrom = null, previewData = null;

  async function openAdd(from, dir) {
    addFrom = from; addDir = dir;
    if (!addFrom || !addDir) return;
    const sel = $("addProfile");
    if (!sel.options.length) {
      for (const [key, spec] of Object.entries((atlas && atlas.profiles) || {})) {
        const o = document.createElement("option");
        o.value = key; o.textContent = spec.label || key;
        sel.appendChild(o);
      }
    }
    $("addWhere").textContent = `${DIR_NAME[addDir]} of plate ${addFrom}`;
    $("addName").value = "";
    $("addSeed").value = "";
    const fromP = atlasIndex.find(p => p.id === addFrom);
    $("addContinent").value = (fromP && fromP.continent_hex != null) ? fromP.continent_hex
      : (model.plate.continent_hex != null ? model.plate.continent_hex : 1);
    $("addModal").hidden = false;
    $("addName").focus();
    rollPreview();
  }
  function closeAdd() { $("addModal").hidden = true; addDir = null; addFrom = null; previewData = null; }

  function addBody() {
    const cont = parseInt($("addContinent").value, 10);
    return {
      from: addFrom, dir: addDir,
      name: $("addName").value.trim() || undefined,
      continent_hex: Number.isFinite(cont) && cont > 0 ? cont : undefined,
      profile: $("addProfile").value,
      seed: $("addSeed").value.trim() || undefined,
      blend: $("addBlend").checked,
    };
  }

  async function rollPreview() {
    const btns = ["addReroll", "addCreate"];
    btns.forEach(b => $(b).disabled = true);
    $("addStats").textContent = "rolling…";
    try {
      const body = addBody();
      // Only write the field back when WE generated the seed — never while the
      // user is typing one, or their preview and the created plate would drift.
      if (!body.seed) { body.seed = `${addFrom}-${addDir}-${Math.random().toString(36).slice(2, 8)}`; $("addSeed").value = body.seed; }
      previewData = await post("/api/plate/preview", body);
      drawPreview(previewData);
      const total = Object.values(previewData.counts).reduce((a, b) => a + b, 0);
      const mix = Object.entries(previewData.counts).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${(model.registry.terrain[k] || {}).label || k} ${Math.round(v / total * 100)}%`).join(" · ");
      $("addStats").textContent = previewData.edge_seeds
        ? `${mix} — ${previewData.edge_seeds} border hexes matched to neighbours` : mix;
    } catch (e) {
      $("addStats").textContent = "preview failed: " + e.message;
      previewData = null;
    }
    btns.forEach(b => $(b).disabled = false);
    $("addCreate").disabled = !previewData;
  }

  function drawPreview(data) {
    const svgEl = $("addPreview");
    svgEl.textContent = "";
    const T = model.registry.terrain;
    for (const h of geo) {
      el("polygon", { points: HexGeo.hexCorners(h.x, h.y, SIZE), fill: (T[data.terrain[h.sub] || data.default_terrain] || {}).color || "#ccc", stroke: "rgba(0,0,0,0.14)", "stroke-width": "1" }, svgEl);
    }
    el("polygon", { points: HexGeo.plateCorners(RL + SIZE * 0.2), fill: "none", stroke: "#2e6f6a", "stroke-width": "5", "stroke-linejoin": "round" }, svgEl);
  }

  async function createPlate() {
    if (!previewData) return;
    $("addCreate").disabled = true;
    $("addStats").textContent = "writing…";
    let res;
    try {
      res = await post("/api/plate", addBody());
    } catch (e) {
      $("addStats").textContent = "create failed: " + e.message;
      $("addCreate").disabled = false;
      return;
    }
    // world position the new plate will occupy in the CURRENT frame
    const fromP = atlasIndex.find(p => p.id === addFrom) || { x: 0, y: 0 };
    const dpx = plateToPx(DIR_AXIAL[addDir][0], DIR_AXIAL[addDir][1]);
    const nw = { x: fromP.x + dpx.x, y: fromP.y + dpx.y };
    closeAdd();

    if (!confirmLeave()) { setStatus(`created plate ${res.id} (staying on ${plateId})`, "ok"); refetchAtlas(); return; }

    let m;
    try { m = await getModel(res.id); } catch (e) { setStatus(`created ${res.id} but could not open it: ${e.message}`, "err"); refetchAtlas(); return; }
    mountActivePlate(m);
    tx += nw.x * s; ty += nw.y * s;    // keep the view put; new plate becomes origin after refetch
    applyTransform();
    await refetchAtlas();               // origin=newId → coords are already new-plate-centred
    updateViewport();
    setStatus(`created plate ${res.id}`, "ok");
  }

  /* ---------- pointer handling ---------- */
  const pointers = new Map();
  let panning = false, painting = false, moved = false, lastPinch = 0;
  function wantPan(e) { return spaceHeld || e.button === 1 || tool === "lines"; }

  svg.addEventListener("pointerdown", e => {
    e.preventDefault();                 // suppresses `click` on SVG children (see top-of-file caveat)
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; lastPinch = Math.hypot(a.x - b.x, a.y - b.y); return; }
    moved = false;
    if (wantPan(e)) { panning = true; svg.classList.add("panning"); }
    else if (tool === "paint") { painting = true; curStroke = {}; paintAt(e.clientX, e.clientY); }
    // lines: acted on pointerup (tap)
  });
  svg.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / lastPinch);
      lastPinch = d; return;
    }
    if (Math.hypot(dx, dy) > 4) moved = true;
    p.x = e.clientX; p.y = e.clientY;
    if (panning) { tx += dx; ty += dy; applyTransform(); }
    else if (painting) paintAt(e.clientX, e.clientY);
  });
  function endPointer(e) {
    const wasTap = pointers.size === 1 && !moved;
    const target = wasTap ? atlasAt(e.clientX, e.clientY) : null;
    if (wasTap && !target && tool === "lines") lineTap(e.clientX, e.clientY);
    pointers.delete(e.pointerId); lastPinch = 0;
    if (panning && pointers.size === 0) { panning = false; svg.classList.remove("panning"); }
    if (painting && pointers.size === 0) {
      painting = false;
      const changes = curStroke ? Object.values(curStroke).filter(c => c.to !== c.from) : [];
      if (changes.length) { undoStack.push(changes); redoStack.length = 0; updateUndoButtons(); }
      curStroke = null;
    }
    // navigate / open the add dialog only after the stroke is closed out
    if (target) { if (target.kind === "slot") openAdd(target.from, target.dir); else gotoPlate(target.id); }
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });

  /* ---------- undo / redo (terrain) ---------- */
  function applyChanges(changes, dir) { for (const c of changes) pd.setTerrain(c.sub, dir === "undo" ? c.from : c.to); }
  function undo() { const c = undoStack.pop(); if (!c) return; applyChanges(c, "undo"); redoStack.push(c); markTerrainDirty(); updateUndoButtons(); }
  function redo() { const c = redoStack.pop(); if (!c) return; applyChanges(c, "redo"); undoStack.push(c); markTerrainDirty(); updateUndoButtons(); }
  function updateUndoButtons() { $("undo").disabled = !undoStack.length; $("redo").disabled = !redoStack.length; }

  /* ---------- dirty / save ---------- */
  function markTerrainDirty() { dirtyTerrain = true; $("save").disabled = false; setStatus("unsaved changes"); }
  function markLinesDirty() { dirtyLines = true; $("save").disabled = false; }
  function setStatus(msg, kind) { const e = $("status"); e.textContent = msg; e.className = kind || ""; }

  async function save() {
    if (!dirtyTerrain && !dirtyLines) return;
    setStatus("saving…");
    try {
      if (dirtyTerrain) {
        const overrides = {};
        for (const h of geo) { const t = model.terrainByNum[h.sub]; if (t !== defaultTerrain) overrides[h.sub] = t; }
        await put(`/api/plate/${plateId}/terrain`, { default_terrain: defaultTerrain, terrain: overrides });
        dirtyTerrain = false;
      }
      if (dirtyLines) {
        await put(`/api/plate/${plateId}/lines`, { lines: workingLines });
        dirtyLines = false;
      }
      $("save").disabled = true;
      setStatus(`saved to plates/${plateId}.yaml`, "ok");
      detailCache.delete(plateId);   // the on-disk detail changed; refetch if shown as context later
    } catch (err) { setStatus("save failed: " + err.message, "err"); }
  }
  async function send(method, url, body) {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "x-editor-token": window.EDITOR_TOKEN }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  }
  const put = (url, body) => send("PUT", url, body);
  const post = (url, body) => send("POST", url, body);

  /* ---------- tools + keyboard ---------- */
  function setTool(t) {
    if (tool === "lines" && t !== "lines" && editing) cancelLine();
    tool = t;
    for (const b of document.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === t);
    // Lines acts on taps, so a drag there is free to pan — hence no Pan mode.
    svg.classList.toggle("tool-pan", t === "lines");
    $("palette").hidden = (t === "lines");
    $("linePanel").hidden = (t !== "lines");
  }
  function wireTools() {
    for (const b of document.querySelectorAll(".tool")) b.addEventListener("click", () => setTool(b.dataset.tool));
    $("undo").addEventListener("click", undo);
    $("redo").addEventListener("click", redo);
    $("fit").addEventListener("click", fitAll);
    $("save").addEventListener("click", save);
    $("newLine").addEventListener("click", startNewLine);
    $("finishLine").addEventListener("click", finishLine);
    $("cancelLine").addEventListener("click", cancelLine);
    $("deleteLine").addEventListener("click", deleteLine);
    $("addReroll").addEventListener("click", () => { $("addSeed").value = ""; rollPreview(); });
    $("addProfile").addEventListener("change", rollPreview);
    $("addBlend").addEventListener("change", rollPreview);
    let seedTimer = null;
    $("addSeed").addEventListener("input", () => { clearTimeout(seedTimer); seedTimer = setTimeout(rollPreview, 300); });
    $("addCancel").addEventListener("click", closeAdd);
    $("addCreate").addEventListener("click", createPlate);
    $("addModal").addEventListener("click", e => { if (e.target === $("addModal")) closeAdd(); });
    window.addEventListener("keydown", e => {
      if (!$("addModal").hidden) {
        if (e.key === "Escape") closeAdd();
        else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); createPlate(); }
        return;
      }
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") { spaceHeld = true; svg.classList.add("tool-pan"); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      else if (tool === "lines" && e.key === "Backspace") { e.preventDefault(); trimLast(); }
      else if (tool === "lines" && e.key === "Enter") { e.preventDefault(); finishLine(); }
      else if (tool === "lines" && e.key === "Escape") { e.preventDefault(); cancelLine(); }
      else if (e.key === "b" || e.key === "B") setTool("paint");
      else if (e.key === "l" || e.key === "L") setTool("lines");
    });
    window.addEventListener("keyup", e => { if (e.code === "Space") { spaceHeld = false; if (tool !== "lines") svg.classList.remove("tool-pan"); } });
    window.addEventListener("beforeunload", e => { if (dirtyTerrain || dirtyLines) { e.preventDefault(); e.returnValue = ""; } });
  }
})();
