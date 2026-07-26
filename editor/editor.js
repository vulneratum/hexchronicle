/*
 * HexChronicle editor client.
 *
 * THERE IS NO SELECTED PLATE. A 36-mile hex is not a mode you enter — it is
 * just where a 3-mile subhex happens to live. Click any subhex on any plate and
 * it is immediately paintable, linkable and editable with whatever tool is
 * active. Nothing re-origins, nothing dims, no plate is "current".
 *
 * The map itself — layers, viewport culling, merged-path terrain, shorelines,
 * the atlas-wide line network, feature anchors, and the hit test — lives in
 * shared/plate-draw.js (PlateDraw.createAtlas), so the editor and the published
 * site are the same renderer with different interaction bolted on. This file is
 * the interaction: tools, panels, undo, and save.
 *
 * WORLD COORDINATES ARE ABSOLUTE. The lattice is anchored on the lowest plate
 * id at (0,0) and never moves, so a world coordinate means the same thing for
 * the whole session and hexAt() is a plain geometric lookup.
 *
 * SEAM OWNERSHIP. A plate is 12 subhexes across, so its rim runs through subhex
 * CENTRES and 30 of its positions are also positions on a neighbour. The hit
 * test resolves every click to the OWNER (lower plate id), so one physical hex
 * has one address, one terrain, one file — whichever side you clicked from.
 *
 * SVG click caveat: pointerdown calls preventDefault() + setPointerCapture,
 * which suppresses the `click` event for everything inside the map. All map
 * interaction routes through endPointer()'s hit test. Never add a click listener
 * to an SVG element.
 */
(function () {
  "use strict";
  const { SIZE, RL, hexCorners, plateCorners, insidePlate, plateToPx } = HexGeo;
  const svg = document.getElementById("map");
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const el = PlateDraw.el;

  /* ---- tuning ---- */
  const PAD_LEFT = 215;                 // canvas taken by the left-hand panel
  const HEX_STROKE = "rgba(0,0,0,0.16)";
  const DIR_NAME = { e: "east", ne: "north-east", nw: "north-west", w: "west", sw: "south-west", se: "south-east" };

  /* ---- state ---- */
  let registry = null, atlas = null, geo = null, bySub = null;
  let atlasDoc = null;                  // the last /api/atlas payload (profiles, problems)
  const plateState = new Map();         // id -> interior state; PRESENT MEANS FULLY LOADED
  const fetching = new Map();           // id -> in-flight detail promise
  const dirtyPlates = new Set();
  const undoStack = [], redoStack = []; // entries: [{plateId, sub, from, to}, …]
  let curStroke = null;

  let selected = null;                  // { plateId, sub } — always the OWNER
  let tool = "paint", brush = null, lineType = null, editing = null;
  let spaceHeld = false;

  /* empty lattice positions — editor-only, see "EMPTY POSITIONS" below */
  let gSlots = null, slotIndex = [], hotSlot = null;
  const slotEls = new Map();

  async function boot() {
    geo = HexGeo.buildPlateHexes();
    bySub = new Map(geo.map(h => [h.sub, h]));
    let a;
    try { a = await getJSON("/api/atlas"); }
    catch (err) { setStatus("load failed: " + err.message, "err"); return; }

    registry = a.registry;
    atlas = PlateDraw.createAtlas(svg, {
      geo, registry,
      gridStroke: HEX_STROKE,
      stateOf: id => plateState.get(id) || null,
      request: id => { ensureState(id).catch(() => {}); },
      linesOf: visibleLinesOf,
      viewportRect,
    });
    // the editor's own overlay, above the map the shared renderer draws
    gSlots = el("g", {}, atlas.world);
    buildPalette();
    buildLineTypes();
    buildMetaChoices();
    wireTools();
    wireMetaPanel();
    wirePlatePanel();
    loadAtlas(a);
    fitAll();
    setStatus("ready — click any hex on any plate");
  }

  const getJSON = url => fetch(url).then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });

  function loadAtlas(a) {
    atlasDoc = a;
    atlas.setPlates(a.plates);
    setSlots(a.empty);
    renderLineList();
    const problems = [];
    if (a.orphans && a.orphans.length) problems.push(`${a.orphans.length} plate(s) not linked to this map`);
    if (a.dangling && a.dangling.length) problems.push(`${a.dangling.length} neighbour link(s) point at a missing plate`);
    if (a.conflicts && a.conflicts.length) problems.push(`${a.conflicts.length} inconsistent neighbour link(s)`);
    if (problems.length) setStatus(problems.join(" · "), "err");
  }
  const refetchAtlas = () => getJSON("/api/atlas").then(loadAtlas)
    .catch(() => setStatus("atlas failed to load", "err"));

  /* ============================================================= *
   * Per-plate interior state
   *
   * A plate is in `plateState` only once its FULL detail has arrived. That is
   * load-bearing, not incidental: PUT /api/plate/:id/lines REPLACES the plate's
   * entire lines array, so writing a plate whose detail was never fetched would
   * silently delete every line it has. `state()` therefore never returns a stub,
   * and save() refuses to write lines for a plate that is not in here.
   * ============================================================= */
  function stateFromDetail(d) {
    const terrain = {};
    for (const h of geo) terrain[h.sub] = d.terrain[h.sub] || d.default_terrain;
    return {
      id: d.id,
      name: d.name || null, title: d.title || null,
      canton: d.canton || null, realm: d.realm || null,
      summary: d.summary || null,
      continent_hex: d.continent_hex, scale_label: d.scale_label || null,
      defaultTerrain: d.default_terrain,
      terrain,
      lines: (d.lines || []).map(l => ({ type: l.type, path: l.path.slice() })),
      hexes: d.hexes || {},
      dirtyTerrain: false, dirtyLines: false, dirtyMeta: false,
      dirtyHexes: new Set(),
    };
  }
  function ensureState(id) {
    const st = plateState.get(id);
    if (st) return Promise.resolve(st);
    const inflight = fetching.get(id);
    if (inflight) return inflight;
    const p = getJSON("/api/plate/" + id + "/detail").then(d => {
      const fresh = stateFromDetail(d);
      plateState.set(id, fresh);
      fetching.delete(id);
      scheduleViewport();
      renderLineList();
      return fresh;
    });
    p.catch(() => fetching.delete(id));
    fetching.set(id, p);
    return p;
  }

  /* ---------- terrain palette ---------- */
  function buildPalette() {
    const T = registry.terrain, box = $("swatches");
    box.textContent = "";
    for (const key of Object.keys(T)) {
      const b = document.createElement("div");
      b.className = "swatch";
      b.innerHTML = `<i style="background:${T[key].color}"></i><span>${T[key].label}</span><span class="key">${key}</span>`;
      b.dataset.key = key;
      b.addEventListener("click", () => selectBrush(key));
      box.appendChild(b);
    }
    selectBrush(Object.keys(T)[0]);
  }
  function selectBrush(key) {
    brush = key;
    for (const b of document.querySelectorAll(".swatch")) b.classList.toggle("active", b.dataset.key === key);
  }

  /* ---------- line-type palette ---------- */
  function buildLineTypes() {
    const L = registry.lines || {}, box = $("lineTypes");
    box.textContent = "";
    for (const key of Object.keys(L)) {
      const spec = L[key];
      const b = document.createElement("button");
      b.className = "ltype";
      b.dataset.type = key;
      b.innerHTML = `<i style="background:${spec.color};height:${Math.max(2, spec.width)}px"></i>${spec.label || key}`;
      b.addEventListener("click", () => {
        lineType = key;
        highlightLineType();
        if (editing) { editing.type = key; renderLines(); updateEditInfo(); }
      });
      box.appendChild(b);
    }
    lineType = Object.keys(L)[0] || null;
    highlightLineType();
  }
  function highlightLineType() {
    for (const b of document.querySelectorAll(".ltype")) b.classList.toggle("active", b.dataset.type === lineType);
  }
  const lineLabel = t => ((registry.lines || {})[t] || {}).label || t;

  /* ---------- pan / zoom ---------- */
  let s = 1, tx = 0, ty = 0;
  function applyTransform() {
    atlas.setView(tx, ty, s);
    scheduleViewport();
  }
  function viewSize() { const r = svg.getBoundingClientRect(); return { w: r.width || innerWidth, h: r.height || innerHeight }; }
  function viewportRect() {
    const v = viewSize();
    return { xmin: (PAD_LEFT - tx) / s, xmax: (v.w - tx) / s, ymin: (0 - ty) / s, ymax: (v.h - ty) / s };
  }
  let vpScheduled = false;
  function scheduleViewport() {
    if (vpScheduled) return;
    vpScheduled = true;
    requestAnimationFrame(() => { vpScheduled = false; atlas.update(); updateSlots(); drawSelection(); drawActive(); });
  }
  function fitAll() {
    const v = viewSize(), b = atlas.bounds();
    const availW = Math.max(200, v.w - PAD_LEFT - 40), availH = Math.max(200, v.h - 110);
    s = Math.min(3, Math.max(0.05, Math.min(availW / (b.maxX - b.minX), availH / (b.maxY - b.minY))));
    tx = PAD_LEFT + availW / 2 - ((b.minX + b.maxX) / 2) * s;
    ty = 70 + availH / 2 - ((b.minY + b.maxY) / 2) * s;
    applyTransform();
  }
  window.addEventListener("resize", () => fitAll());
  function zoomAt(cx, cy, k) {
    const ns = Math.min(3.2, Math.max(0.05, s * k)), real = ns / s;
    tx = cx - (cx - tx) * real; ty = cy - (cy - ty) * real; s = ns;
    applyTransform();
  }
  const toWorld = (clientX, clientY) => ({ x: (clientX - tx) / s, y: (clientY - ty) / s });
  const hexAt = (cx, cy) => { const w = toWorld(cx, cy); return atlas.hexAt(w.x, w.y); };
  const slotAt = (cx, cy) => { const w = toWorld(cx, cy); return slotAtWorld(w.x, w.y); };

  /* ============================================================= *
   * Selection — one hex, anywhere, no plate step
   * ============================================================= */
  function selectHex(hit) {
    selected = hit ? { plateId: hit.plateId, sub: hit.sub } : null;
    if (hit && !plateState.has(hit.plateId)) ensureState(hit.plateId).then(renderPanels).catch(() => {});
    drawSelection();
    renderPanels();
  }
  const selAddress = () => (selected ? atlas.own.addressOf(selected.plateId, selected.sub) : null);

  function drawSelection() {
    atlas.layers.ui.textContent = "";
    if (!selected) return;
    const p = atlas.worldOf(selected.plateId, selected.sub);
    if (!p) return;
    const pts = hexCorners(p.x, p.y, SIZE);
    el("polygon", { points: pts, fill: "none", stroke: "#f3ead0", "stroke-width": 3, "stroke-linejoin": "round" }, atlas.layers.ui);
    el("polygon", { points: pts, fill: "none", stroke: "#2b2b23", "stroke-width": 1, "stroke-linejoin": "round" }, atlas.layers.ui);
    drawActive();
  }
  function renderPanels() {
    $("selAddr").textContent = selAddress() || "—";
    renderMetaPanel();
    renderPlatePanel();
  }

  /* ============================================================= *
   * Terrain painting — on whichever hex was hit
   * ============================================================= */
  function paintAt(cx, cy) {
    const hit = hexAt(cx, cy);
    if (!hit) return;
    if (plateState.has(hit.plateId)) { applyPaint(hit, brush); return; }
    /*
     * Its interior has not arrived yet. Every hex is directly clickable now, so
     * a click near the edge of the viewport can easily land on a plate that is
     * still loading — fetch it and then apply the stroke, rather than making the
     * first click a silent no-op the user has to guess about.
     */
    const want = brush;
    ensureState(hit.plateId).then(() => applyPaint(hit, want)).catch(() => {});
  }
  function applyPaint(hit, want) {
    const st = plateState.get(hit.plateId);
    if (!st) return;
    const from = st.terrain[hit.sub];
    if (from === want) return;
    const change = { plateId: hit.plateId, sub: hit.sub, from, to: want };
    if (curStroke) {
      const key = hit.plateId + ":" + hit.sub;
      if (!(key in curStroke)) curStroke[key] = change;
      curStroke[key].to = want;
    } else {
      // the stroke already closed out while the plate was loading
      undoStack.push([change]); redoStack.length = 0; updateUndoButtons();
    }
    setTerrainAt(hit.plateId, hit.sub, want);
    flushTerrainRebuilds();
    markDirty(hit.plateId, "dirtyTerrain");
  }

  /*
   * One subhex recolour, applied to EVERY plate that shows that position.
   *
   * A seam hex is drawn by two plates (three at a corner) and each keeps its own
   * copy for meshing and shoreline smoothing, so a paint that reached only one
   * of them would put a visible discontinuity right on the boundary. Only the
   * OWNER is marked dirty, so only the owner's file is ever written.
   */
  function setTerrainAt(id, sub, type) {
    const o = atlas.own.ownerOf(id, sub);
    if (!plateState.has(o.plateId)) return;
    for (const c of atlas.own.sharersOf(o.plateId, o.sub)) {
      const cst = plateState.get(c.plateId);
      if (!cst) continue;
      cst.terrain[c.sub] = type;
      atlas.invalidate(c.plateId);
    }
  }
  function flushTerrainRebuilds() { atlas.refresh(); drawSelection(); }

  /* ============================================================= *
   * Line features
   *
   * A line is edited as ONE path of owner addresses that may cross any number of
   * plates. It is STORED split at the seams — a plate's `lines:` array can only
   * name that plate's own subhexes — and the pieces overlap by the shared hex,
   * so the atlas-wide network joins them back into one continuous line.
   * ============================================================= */
  const addrOf = hit => atlas.own.addressOf(hit.plateId, hit.sub);
  const qualify = (path, ownerId) => path.map(e => {
    const a = HexGeo.parseAddr(e);
    if (!a) return null;
    return atlas.own.addressOf(a.plate || ownerId, a.sub);
  }).filter(Boolean);

  /* hide the piece being edited; the in-progress overlay stands in for it */
  function visibleLinesOf(id, st) {
    if (editing && editing.from && editing.from.plateId === id) {
      return st.lines.filter((_, i) => i !== editing.from.index);
    }
    return st.lines;
  }
  function renderLines() { atlas.renderLines(); drawActive(); renderLineList(); }

  /*
   * Split a path of owner addresses into one piece per plate.
   *
   * Every pair of adjacent world positions is held by at least one plate (a
   * plate's rim overlaps its neighbour's by a full row of shared hexes), so a
   * run can always be extended until no single plate holds the next hex too.
   * The next piece then RESTARTS on the shared hex, so consecutive pieces
   * overlap by one and the drawn line has no gap at the seam.
   */
  function claimsOf(addr) {
    const a = HexGeo.parseAddr(addr);
    const o = atlas.own.ownerOf(a.plate, a.sub);
    return new Map(atlas.own.sharersOf(o.plateId, o.sub).map(c => [c.plateId, c.sub]));
  }
  function splitPath(path) {
    const pieces = [];
    let start = 0;
    while (start < path.length - 1) {
      // grow the longest run from `start` that ONE plate can name end to end
      let cand = new Set(claimsOf(path[start]).keys()), end = start;
      while (end + 1 < path.length) {
        const next = claimsOf(path[end + 1]);
        const merged = new Set([...cand].filter(p => next.has(p)));
        if (!merged.size) break;
        cand = merged; end++;
      }
      if (end === start) break;        // no plate holds this edge: impossible on a real lattice
      const run = path.slice(start, end + 1);
      const plateId = pickHolder(run, [...cand]);
      pieces.push({ plateId, path: run.map(a => claimsOf(a).get(plateId)) });
      start = end;                     // the shared hex also starts the next piece
    }
    return pieces;
  }
  /* prefer the plate that OWNS most of the run, then the lower id */
  function pickHolder(run, holders) {
    const score = new Map(holders.map(p => [p, 0]));
    for (const addr of run) {
      const o = HexGeo.parseAddr(addr);
      if (score.has(o.plate)) score.set(o.plate, score.get(o.plate) + 1);
    }
    return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  }

  function startNewLine() {
    editing = { from: null, type: lineType, path: [] };
    showEditUI(); renderLines(); updateEditInfo();
    setStatus(`drawing a new ${lineLabel(lineType)} — click hexes on any plate`);
  }
  function selectLine(plateId, index) {
    const st = plateState.get(plateId);
    if (!st) return;
    const src = st.lines[index];
    editing = { from: { plateId, index }, type: src.type, path: qualify(src.path, plateId) };
    lineType = editing.type; highlightLineType();
    showEditUI(); renderLines(); updateEditInfo();
    setStatus(`editing ${lineLabel(editing.type)} on plate ${plateId} · click to extend, Backspace to trim`);
  }

  function lineTap(hit) {
    const addr = addrOf(hit);
    if (editing) {
      if (editing.path[editing.path.length - 1] === addr) return;
      if (!plateState.has(hit.plateId)) { ensureState(hit.plateId).catch(() => {}); return; }
      editing.path.push(addr);
      renderLines(); updateEditInfo();
      return;
    }
    for (const [id, st] of plateState) {
      const i = st.lines.findIndex(l => qualify(l.path, id).includes(addr));
      if (i >= 0) { selectLine(id, i); return; }
    }
  }
  function trimLast() { if (editing && editing.path.length) { editing.path.pop(); renderLines(); updateEditInfo(); } }

  async function finishLine() {
    if (!editing) return;
    if (editing.path.length < 2) { setStatus("a line needs at least 2 hexes", "err"); return; }
    const pieces = splitPath(editing.path);
    const touched = new Set(pieces.map(p => p.plateId));
    if (editing.from) touched.add(editing.from.plateId);

    // A plate's lines array is REPLACED on save, so every plate about to receive
    // a piece must have its full interior in hand first.
    try { await Promise.all([...touched].map(ensureState)); }
    catch (err) { setStatus("could not load a plate the line crosses: " + err.message, "err"); return; }

    if (editing.from) {
      const st = plateState.get(editing.from.plateId);
      st.lines.splice(editing.from.index, 1);
      markDirty(editing.from.plateId, "dirtyLines");
    }
    for (const piece of pieces) {
      plateState.get(piece.plateId).lines.push({ type: editing.type, path: piece.path });
      markDirty(piece.plateId, "dirtyLines");
    }
    editing = null; hideEditUI();
    renderLines();
    setStatus(pieces.length > 1
      ? `line set, split across ${pieces.map(p => p.plateId).join(" + ")} — Save to write it`
      : `line set on plate ${pieces[0].plateId} — Save to write it`);
  }
  function cancelLine() { editing = null; hideEditUI(); renderLines(); setStatus("edit cancelled"); }
  function deleteLine() {
    if (!editing || !editing.from) return;
    const st = plateState.get(editing.from.plateId);
    st.lines.splice(editing.from.index, 1);
    markDirty(editing.from.plateId, "dirtyLines");
    editing = null; hideEditUI(); renderLines();
    setStatus("line deleted — Save to write it");
  }

  function showEditUI() { $("lineEdit").hidden = false; $("lineIdleHint").hidden = true; $("deleteLine").hidden = !(editing && editing.from); }
  function hideEditUI() { $("lineEdit").hidden = true; $("lineIdleHint").hidden = false; }
  function updateEditInfo() {
    if (!editing) return;
    const n = editing.path.length;
    const crossed = [...new Set(editing.path.map(a => HexGeo.parseAddr(a).plate))];
    $("editInfo").innerHTML = `<b>${esc(lineLabel(editing.type))}</b> · ${n} hex${n === 1 ? "" : "es"}`
      + (crossed.length > 1 ? `<br><span class="sub">crosses ${crossed.join(" → ")} — it will be split at the seam</span>` : "");
  }

  /* every line on every loaded plate, so there is no "lines on this plate" */
  function renderLineList() {
    const box = $("lineList");
    if (!box) return;
    const all = [];
    for (const [id, st] of plateState) st.lines.forEach((l, i) => all.push({ id, i, l }));
    if (!all.length) { box.innerHTML = `<div class="lineitem"><span class="empty">No lines yet.</span></div>`; return; }
    box.textContent = "";
    for (const { id, i, l } of all) {
      const d = document.createElement("div");
      d.className = "lineitem" + (editing && editing.from && editing.from.plateId === id && editing.from.index === i ? " active" : "");
      d.innerHTML = `<b>${esc(lineLabel(l.type))}</b><span class="sub">${esc(id)} · ${l.path.length} hexes</span>`;
      d.addEventListener("click", () => selectLine(id, i));
      box.appendChild(d);
    }
  }

  /* the in-progress path, drawn in the UI layer over everything */
  function drawActive() {
    const layer = atlas.layers.ui;
    const old = layer.querySelector(".activeline");
    if (old) old.remove();
    if (!editing || !editing.path.length) return;
    const g = el("g", { class: "activeline" }, layer);
    const st = atlas.lineStyle(editing.type);
    const pts = [];
    for (const addr of editing.path) {
      const a = HexGeo.parseAddr(addr);
      const p = a && atlas.worldOf(a.plate, a.sub);
      if (p) pts.push(p);
    }
    if (pts.length >= 2) {
      const d = "M " + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
      el("path", { d, fill: "none", stroke: st.color, "stroke-width": st.width, "stroke-linecap": "round", opacity: "0.55" }, g);
      el("path", { d, fill: "none", stroke: "#f3ead0", "stroke-width": "1.4", "stroke-dasharray": "4 4", "stroke-linecap": "round" }, g);
    }
    pts.forEach((p, i) => {
      el("circle", { cx: p.x, cy: p.y, r: i === 0 || i === pts.length - 1 ? 4 : 2.6, fill: "#f3ead0", stroke: "#2b2b23", "stroke-width": "1.2" }, g);
    });
  }

  /* ============================================================= *
   * Per-hex metadata
   * ============================================================= */
  function buildMetaChoices() {
    const t = $("metaTerrain");
    t.textContent = "";
    for (const [key, spec] of Object.entries(registry.terrain)) {
      const o = document.createElement("option");
      o.value = key; o.textContent = spec.label || key;
      t.appendChild(o);
    }
    const f = $("metaFeatureType");
    f.textContent = "";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "— none —";
    f.appendChild(none);
    for (const [key, spec] of Object.entries(registry.features || {})) {
      const o = document.createElement("option");
      o.value = key; o.textContent = spec.label || key;
      f.appendChild(o);
    }
  }

  function hexRecord(st, sub, create) {
    let rec = st.hexes[sub];
    if (!rec && create) rec = st.hexes[sub] = { name: null, visibility: "public", feature: null, local_memory: null, chronicle: [] };
    return rec || null;
  }

  /* every line crossing this hex, whichever plate stores the piece */
  function linesThrough(plateId, sub) {
    const addr = atlas.own.addressOf(plateId, sub), out = [];
    for (const [id, st] of plateState) {
      for (const l of st.lines) {
        if (qualify(l.path, id).includes(addr)) out.push(lineLabel(l.type) + (id === plateId ? "" : ` (stored on ${id})`));
      }
    }
    return [...new Set(out)];
  }

  function renderMetaPanel() {
    const st = selected && plateState.get(selected.plateId);
    $("metaIdle").hidden = !!st;
    $("metaBody").hidden = !st;
    if (!st) return;
    const sub = selected.sub, rec = hexRecord(st, sub, false) || {};
    const addr = selAddress();
    const file = `hexes/${addr}.yaml`;

    $("metaAddr").textContent = addr;
    const shared = atlas.own.sharersOf(selected.plateId, sub)
      .filter(c => c.plateId !== selected.plateId).map(c => `${c.plateId} (as ${c.sub})`);
    const lines = linesThrough(selected.plateId, sub);
    const ro = [
      ["36-mile hex", `${selected.plateId}${st.name ? " · " + st.name : ""}`],
      ["Subhex", sub],
      ["Also shown on", shared.length ? shared.join(", ") : "—"],
      ["Scale", "3 miles (1 league)"],
      ["Lines", lines.length ? lines.join(", ") : "none"],
      ["File", rec.file ? file : file + " (not created yet)"],
    ];
    $("metaDerived").innerHTML = ro.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

    $("metaName").value = rec.name || "";
    $("metaTerrain").value = st.terrain[sub] || st.defaultTerrain;
    $("metaFeatureType").value = (rec.feature && rec.feature.type) || "";
    $("metaFeatureName").value = (rec.feature && rec.feature.name) || "";
    $("metaFeatureName").disabled = !(rec.feature && rec.feature.type);
    $("metaVisibility").value = rec.visibility || "public";

    const story = [];
    if (rec.local_memory) story.push(`<div class="mem">${esc(rec.local_memory)}</div>`);
    for (const c of (rec.chronicle || [])) {
      story.push(`<div class="cx"><b>${esc(c.date)}${c.visibility === "gm-only" ? " · gm-only" : ""}</b>${esc(c.text)}</div>`);
    }
    $("metaStory").innerHTML = story.length ? story.join("") : `<span class="empty">Nothing recorded yet.</span>`;
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function metaEdit(mutate) {
    if (!selected) return;
    const st = plateState.get(selected.plateId);
    if (!st) return;
    const rec = hexRecord(st, selected.sub, true);
    mutate(rec, st);
    st.dirtyHexes.add(selected.sub);
    markDirty(selected.plateId, "dirtyMeta");
    // the feature set decides which hexes have an anchor, so the roads that
    // reach this hex are re-routed along with the icon
    atlas.invalidate(selected.plateId);
    atlas.refresh();
    drawSelection();
  }

  function wireMetaPanel() {
    $("metaName").addEventListener("input", () => metaEdit(rec => { rec.name = $("metaName").value.trim() || null; }));
    $("metaFeatureName").addEventListener("input", () => metaEdit(rec => {
      if (rec.feature) rec.feature.name = $("metaFeatureName").value.trim() || null;
    }));
    $("metaFeatureType").addEventListener("change", () => {
      const type = $("metaFeatureType").value;
      metaEdit(rec => {
        if (!type) rec.feature = null;
        else rec.feature = { type, name: rec.feature ? rec.feature.name : null };
      });
      renderMetaPanel();
    });
    $("metaVisibility").addEventListener("change", () => metaEdit(rec => { rec.visibility = $("metaVisibility").value; }));
    // Terrain is plate data — same path the brush takes, undo included.
    $("metaTerrain").addEventListener("change", () => {
      if (!selected) return;
      const st = plateState.get(selected.plateId);
      if (!st) return;
      const from = st.terrain[selected.sub], to = $("metaTerrain").value;
      if (from === to) return;
      setTerrainAt(selected.plateId, selected.sub, to);
      flushTerrainRebuilds();
      markDirty(selected.plateId, "dirtyTerrain");
      undoStack.push([{ plateId: selected.plateId, sub: selected.sub, from, to }]);
      redoStack.length = 0; updateUndoButtons();
    });
  }

  /* ============================================================= *
   * The containing plate's own fields
   * ============================================================= */
  const PLATE_FIELDS = [
    ["plateName", "name"], ["plateTitle", "title"], ["plateCanton", "canton"],
    ["plateRealm", "realm"], ["plateContinent", "continent_hex"],
    ["plateScale", "scale_label"], ["plateSummary", "summary"],
  ];
  function renderPlatePanel() {
    const st = selected && plateState.get(selected.plateId);
    $("platePanel").hidden = !st;
    if (!st) return;
    $("plateWho").textContent = `36-mile hex ${st.id}`;
    for (const [elId, key] of PLATE_FIELDS) $(elId).value = st[key] == null ? "" : st[key];
  }
  function wirePlatePanel() {
    for (const [elId, key] of PLATE_FIELDS) {
      $(elId).addEventListener("input", () => {
        const st = selected && plateState.get(selected.plateId);
        if (!st) return;
        const raw = $(elId).value;
        st[key] = key === "continent_hex" ? (parseInt(raw, 10) || null) : (raw.trim() || null);
        markDirty(st.id, "dirtyMeta");
        st.dirtyPlateMeta = true;
        if (key === "name") { refreshPlateLabels(st); }
      });
    }
  }
  function refreshPlateLabels(st) {
    const rec = atlas.recs.get(st.id);
    if (rec) rec.label.textContent = st.name || st.id;
  }

  /* ============================================================= *
   * EMPTY POSITIONS — an editor affordance, and only ever that
   *
   * A lattice position with no 36-mile hex in it yet is somewhere you can make
   * one. That is a fact about EDITING, not about the world, so none of this
   * lives in shared/plate-draw.js: the shared renderer has no concept of a
   * slot, cannot be asked to draw one, and there is no flag that could be set
   * wrong. The published site gets the map and nothing else because the code
   * that would draw editor chrome is not in the module it loads.
   *
   * The marker itself is just the glyph and its label — no outline, no fill.
   * The HIT TARGET is unchanged and is geometric, not the drawn shape: the
   * whole 36-mile hexagon is clickable, exactly as when it had a border. Since
   * there is nothing to see at the edges of that target, hover brightens the
   * glyph so it is still discoverable.
   * ============================================================= */
  function setSlots(list) {
    slotIndex = (list || []).map(t => {
      const o = plateToPx(t.coord[0], t.coord[1]);
      return { from: t.from, dir: t.dir, x: o.x, y: o.y, key: t.from + "|" + t.dir };
    });
    for (const [, g] of slotEls) g.remove();
    slotEls.clear();
    updateSlots();
  }

  /* built only where they are on screen, like everything else on this canvas */
  function updateSlots() {
    if (!atlas) return;
    const vp = viewportRect(), margin = RL * 0.6;
    const vis = slotIndex.filter(t =>
      t.x + RL + margin > vp.xmin && t.x - RL - margin < vp.xmax &&
      t.y + RL + margin > vp.ymin && t.y - RL - margin < vp.ymax);
    const want = new Set(vis.map(t => t.key));
    for (const [k, g] of slotEls) if (!want.has(k)) { g.remove(); slotEls.delete(k); }
    for (const t of vis) {
      if (slotEls.has(t.key)) continue;
      const g = el("g", { class: "addmark", transform: `translate(${t.x.toFixed(1)} ${t.y.toFixed(1)})` }, gSlots);
      const plus = el("text", { "text-anchor": "middle", y: 46, "font-size": 132, "font-weight": 700, "font-family": "'Alegreya Sans',sans-serif" }, g);
      plus.textContent = "+";
      const cap = el("text", { "text-anchor": "middle", y: 104, "font-size": 30, "letter-spacing": "4", "font-family": "'IBM Plex Mono',monospace" }, g);
      cap.textContent = "ADD 36-MI HEX";
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = `Add a new 36-mile hex ${DIR_NAME[t.dir]} of plate ${t.from}`;
      g.appendChild(title);
      slotEls.set(t.key, g);
    }
  }

  /* the whole hexagon, not the glyph — the target never depended on the border */
  const slotAtWorld = (wx, wy) => slotIndex.find(t => insidePlate(wx - t.x, wy - t.y, RL)) || null;

  /* hover, since there is no longer an outline to aim at */
  function hoverSlot(clientX, clientY) {
    const w = toWorld(clientX, clientY);
    const t = slotAtWorld(w.x, w.y);
    const key = t ? t.key : null;
    if (key === hotSlot) return;
    hotSlot = key;
    for (const [k, g] of slotEls) g.classList.toggle("hot", k === hotSlot);
  }

  /* ---------- add-new-plate flow ---------- */
  let addDir = null, addFrom = null, previewData = null;

  async function openAdd(from, dir) {
    addFrom = from; addDir = dir;
    if (!addFrom || !addDir) return;
    const sel = $("addProfile");
    if (!sel.options.length) {
      for (const [key, spec] of Object.entries((atlasDoc && atlasDoc.profiles) || {})) {
        const o = document.createElement("option");
        o.value = key; o.textContent = spec.label || key;
        sel.appendChild(o);
      }
    }
    $("addWhere").textContent = `${DIR_NAME[addDir]} of plate ${addFrom}`;
    $("addName").value = "";
    $("addSeed").value = "";
    const fromP = atlas.plates.find(p => p.id === addFrom);
    $("addContinent").value = (fromP && fromP.continent_hex != null) ? fromP.continent_hex : 1;
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
      if (!body.seed) { body.seed = `${addFrom}-${addDir}-${Math.random().toString(36).slice(2, 8)}`; $("addSeed").value = body.seed; }
      previewData = await post("/api/plate/preview", body);
      drawPreview(previewData);
      const total = Object.values(previewData.counts).reduce((a, b) => a + b, 0);
      const mix = Object.entries(previewData.counts).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${(registry.terrain[k] || {}).label || k} ${Math.round(v / total * 100)}%`).join(" · ");
      $("addStats").textContent = previewData.edge_seeds
        ? `${mix} — ${previewData.edge_seeds} border hexes matched to neighbours` : mix;
    } catch (e) {
      $("addStats").textContent = "preview failed: " + e.message;
      previewData = null;
    }
    btns.forEach(b => $(b).disabled = false);
    $("addCreate").disabled = !previewData;
  }
  /* the rolled candidate, drawn through the same mesh so the preview shows the
   * coastlines you will actually get */
  function drawPreview(data) {
    const svgEl = $("addPreview");
    svgEl.textContent = "";
    PlateDraw.renderTerrainInto(svgEl, atlas.mesh, s2 => data.terrain[s2] || data.default_terrain,
      atlas.colorOf, { gridStroke: HEX_STROKE });
    el("polygon", { points: plateCorners(RL + SIZE * 0.2), fill: "none", stroke: "#2e6f6a", "stroke-width": "5", "stroke-linejoin": "round" }, svgEl);
  }
  async function createPlate() {
    if (!previewData) return;
    $("addCreate").disabled = true;
    setStatus("creating plate…");
    try {
      const res = await post("/api/plate", addBody());
      closeAdd();
      await refetchAtlas();
      scheduleViewport();
      setStatus(`created plate ${res.id} · ${res.overrides} terrain overrides`
        + (res.back_linked && res.back_linked.length ? ` · linked to ${res.back_linked.join(", ")}` : ""), "ok");
    } catch (e) {
      setStatus("create failed: " + e.message, "err");
      $("addCreate").disabled = false;
    }
  }

  /* ============================================================= *
   * Pointer input — every interaction routes through the hit test
   * ============================================================= */
  const pointers = new Map();
  let panning = false, painting = false, moved = false, lastPinch = 0;
  const wantPan = e => spaceHeld || e.button === 1 || tool === "lines" || tool === "meta";

  svg.addEventListener("pointerdown", e => {
    e.preventDefault();                 // suppresses `click` on SVG children
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; lastPinch = Math.hypot(a.x - b.x, a.y - b.y); return; }
    moved = false;
    if (wantPan(e)) { panning = true; svg.classList.add("panning"); }
    else if (tool === "paint") { painting = true; curStroke = {}; paintAt(e.clientX, e.clientY); }
  });
  // hover runs whether or not a pointer is down, so it needs its own listener
  svg.addEventListener("pointermove", e => {
    if (!panning && !painting) hoverSlot(e.clientX, e.clientY);
  });
  svg.addEventListener("pointerleave", () => hoverSlot(-1e9, -1e9));
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
    const slot = wasTap ? slotAt(e.clientX, e.clientY) : null;
    const hit = (wasTap && !slot) ? hexAt(e.clientX, e.clientY) : null;
    pointers.delete(e.pointerId); lastPinch = 0;
    if (panning && pointers.size === 0) { panning = false; svg.classList.remove("panning"); }
    if (painting && pointers.size === 0) {
      painting = false;
      const changes = curStroke ? Object.values(curStroke).filter(c => c.to !== c.from) : [];
      if (changes.length) { undoStack.push(changes); redoStack.length = 0; updateUndoButtons(); }
      curStroke = null;
      flushTerrainRebuilds();
    }
    if (slot) { openAdd(slot.from, slot.dir); return; }
    if (!hit) return;
    // ONE click: select the hex, and act on it with whatever tool is in hand
    selectHex(hit);
    if (tool === "lines") lineTap(hit);
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });

  /* ---------- undo / redo (terrain, across plates) ---------- */
  function applyChanges(changes, dir) {
    for (const c of changes) {
      setTerrainAt(c.plateId, c.sub, dir === "undo" ? c.from : c.to);
      markDirty(c.plateId, "dirtyTerrain");
    }
    flushTerrainRebuilds();
  }
  function undo() { const c = undoStack.pop(); if (!c) return; applyChanges(c, "undo"); redoStack.push(c); updateUndoButtons(); }
  function redo() { const c = redoStack.pop(); if (!c) return; applyChanges(c, "redo"); undoStack.push(c); updateUndoButtons(); }
  function updateUndoButtons() { $("undo").disabled = !undoStack.length; $("redo").disabled = !redoStack.length; }

  /* ---------- dirty / save ---------- */
  function markDirty(id, kind) {
    const st = plateState.get(id);
    if (!st) return;
    st[kind] = true;
    dirtyPlates.add(id);
    $("save").disabled = false;
    setStatus(dirtyPlates.size === 1
      ? `unsaved changes on ${[...dirtyPlates][0]}`
      : `unsaved changes on ${dirtyPlates.size} plates`);
  }
  function setStatus(msg, kind) { const e = $("status"); e.textContent = msg; e.className = kind || ""; }

  /*
   * Every dirty plate, written through its own endpoints — one file each.
   *
   * A plate that fails KEEPS its dirty flags and stays in dirtyPlates, so Save
   * stays available and nothing is quietly lost; a plate that succeeds is
   * cleared independently of its neighbours. The report names both.
   */
  async function save() {
    if (!dirtyPlates.size) return;
    setStatus("saving…");
    const written = [], failed = [];

    for (const id of [...dirtyPlates]) {
      const st = plateState.get(id);
      if (!st) { dirtyPlates.delete(id); continue; }
      let ok = true;
      const fail = (what, err) => { ok = false; failed.push(`${id} ${what}: ${err.message}`); };

      if (st.dirtyTerrain) {
        try {
          // Only the positions this plate OWNS: the seam positions it merely
          // shows belong to the lower-numbered neighbour and are that plate's
          // to write.
          const overrides = {};
          for (const h of geo) {
            if (atlas.own.isBorrowed(id, h.sub)) continue;
            const t = st.terrain[h.sub];
            if (t !== st.defaultTerrain) overrides[h.sub] = t;
          }
          await put(`/api/plate/${id}/terrain`, { default_terrain: st.defaultTerrain, terrain: overrides });
          st.dirtyTerrain = false;
          written.push(`plates/${id}.yaml (terrain)`);
        } catch (err) { fail("terrain", err); }
      }

      if (st.dirtyLines) {
        // THE HAZARD: this endpoint replaces the plate's whole lines array. A
        // plate is only ever in plateState with its full detail loaded, so this
        // cannot send a truncated list — but assert it rather than trust it.
        if (!Array.isArray(st.lines)) { fail("lines", new Error("interior not loaded")); }
        else {
          try {
            await put(`/api/plate/${id}/lines`, { lines: st.lines });
            st.dirtyLines = false;
            written.push(`plates/${id}.yaml (lines)`);
          } catch (err) { fail("lines", err); }
        }
      }

      if (st.dirtyPlateMeta) {
        try {
          await put(`/api/plate/${id}/meta`, {
            name: st.name, title: st.title, canton: st.canton, realm: st.realm,
            summary: st.summary, continent_hex: st.continent_hex, scale_label: st.scale_label,
          });
          st.dirtyPlateMeta = false;
          written.push(`plates/${id}.yaml (description)`);
        } catch (err) { fail("description", err); }
      }

      for (const sub of [...st.dirtyHexes]) {
        const rec = st.hexes[sub] || {};
        try {
          // The three MAP keys, named explicitly. chronicle and local_memory are
          // held in `rec` for display and are structurally unable to travel.
          await put(`/api/hex/${id}/${sub}`, {
            name: rec.name || null,
            visibility: rec.visibility || "public",
            feature: (rec.feature && rec.feature.type) ? { type: rec.feature.type, name: rec.feature.name || null } : null,
          });
          rec.file = `hexes/${atlas.own.addressOf(id, sub)}.yaml`;
          written.push(rec.file);
          st.dirtyHexes.delete(sub);
        } catch (err) { fail(`hex ${sub}`, err); }
      }

      if (ok) { st.dirtyMeta = false; dirtyPlates.delete(id); }
    }

    $("save").disabled = dirtyPlates.size === 0;
    if (failed.length) {
      setStatus(`saved ${written.length} file(s); FAILED — ${failed.join(" · ")}`, "err");
    } else {
      setStatus(written.length === 1 ? `saved ${written[0]}` : `saved ${written.length} files: ${written.join(", ")}`, "ok");
    }
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
    svg.classList.toggle("tool-pan", t === "lines" || t === "meta");
    $("palette").hidden = (t !== "paint");
    $("linePanel").hidden = (t !== "lines");
    $("metaPanel").hidden = (t !== "meta");
    if (t === "meta") renderPanels();
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
      else if (e.key === "m" || e.key === "M") setTool("meta");
    });
    window.addEventListener("keyup", e => { if (e.code === "Space") { spaceHeld = false; if (tool !== "lines") svg.classList.remove("tool-pan"); } });
    window.addEventListener("beforeunload", e => { if (dirtyPlates.size) { e.preventDefault(); e.returnValue = ""; } });
  }

  boot();      // last: everything above is in scope by the time it runs
})();
