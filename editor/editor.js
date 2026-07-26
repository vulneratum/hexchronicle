/*
 * HexChronicle editor client.
 *   Phase 1 — terrain paint brush + Save.
 *   Phase 2 — line tools: draw a river/road by clicking hexes in sequence;
 *             select an existing line to extend/reroute (append + Backspace),
 *             change its type/grade, or delete it. Writes the plate's lines:
 *             block comment-preservingly via the server.
 * Draws with the shared PlateDraw core; adds the editing interaction here.
 */
(function () {
  "use strict";
  const { SIZE, RL, SQ3, pxToAxial } = HexGeo;
  const svg = document.getElementById("map");
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";

  let model, geo, byKey, pd, plateId, defaultTerrain;
  let camera = null, gAtlas = null;        // camera holds pan/zoom; gAtlas holds every other plate
  let context = [], slots = [];            // hit-testable: other plates, and addable empty positions
  let brush;                       // terrain brush
  let tool = "paint", spaceHeld = false;
  let dirtyTerrain = false, dirtyLines = false;
  const undoStack = [], redoStack = [];

  // line-tool state
  let workingLines = [];           // [{type, path:[sub]}] — source of truth for lines
  let lineType = null;             // selected grade for new/retype
  let editing = null;              // null | { orig:number|null, type, path:[sub] }
  let gEdit = null;                // overlay group for the in-progress path

  const QUERY_PLATE = new URLSearchParams(location.search).get("plate");

  fetch("/api/model" + (QUERY_PLATE ? "?plate=" + encodeURIComponent(QUERY_PLATE) : ""))
    .then(r => r.json()).then(init).catch(err => setStatus("load failed: " + err, "err"));

  function init(m) {
    model = m;
    plateId = m.plate.id;
    defaultTerrain = m.plate.default_terrain;
    $("plateId").textContent = plateId;
    document.title = `HexChronicle Editor — Plate ${plateId}`;

    geo = HexGeo.buildPlateHexes();
    byKey = new Map(geo.map(h => [h.key, h]));
    model.geo = geo;
    pd = PlateDraw.create(svg, model);

    // Re-parent the active plate under a camera group so the surrounding atlas
    // pans and zooms with it. The active plate stays at world origin, which is
    // why every painting/line coordinate below needs no adjustment at all.
    camera = document.createElementNS(SVGNS, "g");
    gAtlas = document.createElementNS(SVGNS, "g");
    svg.appendChild(camera);
    camera.appendChild(gAtlas);            // context plates draw beneath
    camera.appendChild(pd.world);

    // the per-plate chips are replaced by full-size slots drawn across the atlas
    for (const c of pd.neighborChips) c.g.remove();

    gEdit = document.createElementNS(SVGNS, "g");
    pd.world.appendChild(gEdit);

    workingLines = (model.lines || []).map(l => ({ type: l.type, path: l.path.slice() }));

    buildPalette();
    buildLineTypes();
    renderLineList();
    wireTools();
    setStatus("ready");

    fetch("/api/atlas?origin=" + encodeURIComponent(plateId))
      .then(r => r.json())
      .then(a => { atlas = a; renderAtlas(a); fitAll(); })
      .catch(() => { fitAll(); setStatus("atlas failed to load", "err"); });
  }

  /* ---------- terrain palette (from theme registry) ---------- */
  function buildPalette() {
    const T = model.registry.terrain, box = $("swatches");
    box.textContent = "";
    for (const key of Object.keys(T)) {
      const b = document.createElement("div");
      b.className = "swatch" + (key === defaultTerrain ? " active" : "");
      b.innerHTML = `<i style="background:${T[key].color}"></i><span>${T[key].label}</span><span class="key">${key}</span>`;
      b.dataset.key = key;
      b.addEventListener("click", () => selectBrush(key));
      box.appendChild(b);
    }
    // Starting the brush on the plate's default terrain makes the Paint tool
    // look broken — every stroke is a no-op until you pick another swatch.
    // Start on the first type that is NOT the default instead.
    brush = Object.keys(T).find(k => k !== defaultTerrain) || defaultTerrain;
    selectBrush(brush);
  }
  function selectBrush(key) {
    brush = key;
    for (const el of document.querySelectorAll(".swatch")) el.classList.toggle("active", el.dataset.key === key);
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
    for (const el of document.querySelectorAll(".ltype")) el.classList.toggle("active", el.dataset.key === lineType);
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
  }
  function viewSize() { const r = svg.getBoundingClientRect(); return { w: r.width || innerWidth, h: r.height || innerHeight }; }
  /*
   * Frame every existing plate. The old version fitted a single plate with a
   * hardcoded nudge; this measures the real bounds of the atlas and centres it
   * in the canvas left of the palette.
   */
  const PAD_LEFT = 215;                    // palette panel
  function fitAll() {
    const v = viewSize();
    const centres = [{ x: 0, y: 0 }, ...context];
    const minX = Math.min(...centres.map(c => c.x)) - RL - SIZE;
    const maxX = Math.max(...centres.map(c => c.x)) + RL + SIZE;
    const minY = Math.min(...centres.map(c => c.y)) - RL - SIZE;
    const maxY = Math.max(...centres.map(c => c.y)) + RL + SIZE;

    const availW = Math.max(200, v.w - PAD_LEFT - 40), availH = Math.max(200, v.h - 110);
    s = Math.min(3, Math.max(0.05, Math.min(availW / (maxX - minX), availH / (maxY - minY))));
    tx = PAD_LEFT + availW / 2 - ((minX + maxX) / 2) * s;
    ty = 70 + availH / 2 - ((minY + maxY) / 2) * s;
    applyTransform();
  }
  const fitPlate = fitAll;
  window.addEventListener("resize", () => fitAll());
  function zoomAt(cx, cy, k) {
    const ns = Math.min(3.2, Math.max(0.3, s * k)), real = ns / s;
    tx = cx - (cx - tx) * real; ty = cy - (cy - ty) * real; s = ns;
    applyTransform();
  }

  function hexAt(clientX, clientY) {
    const a = pxToAxial((clientX - tx) / s, (clientY - ty) / s);
    return byKey.get(a.q + "," + a.r) || null;
  }

  /* ---------- terrain painting ---------- */
  let curStroke = null;
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
      const base = document.createElementNS(SVGNS, "path");
      base.setAttribute("d", d); base.setAttribute("fill", "none");
      base.setAttribute("stroke", st.color); base.setAttribute("stroke-width", st.width);
      base.setAttribute("stroke-linecap", "round"); base.setAttribute("opacity", "0.55");
      gEdit.appendChild(base);
      const over = document.createElementNS(SVGNS, "path");
      over.setAttribute("d", d); over.setAttribute("fill", "none");
      over.setAttribute("stroke", "#f3ead0"); over.setAttribute("stroke-width", "1.4");
      over.setAttribute("stroke-dasharray", "4 4"); over.setAttribute("stroke-linecap", "round");
      gEdit.appendChild(over);
    }
    pts.forEach((p, i) => {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
      c.setAttribute("r", i === 0 || i === pts.length - 1 ? 4 : 2.6);
      c.setAttribute("fill", "#f3ead0"); c.setAttribute("stroke", "#2b2b23"); c.setAttribute("stroke-width", "1.2");
      gEdit.appendChild(c);
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


  /* ---------- the atlas: every plate on screen at once ---------- */
  /*
   * Plates tile as point-up hexagons of circumradius RL, so the plate lattice
   * uses the same axial convention as subhexes do — just scaled up. The active
   * plate sits at (0,0); everything else is placed relative to it.
   */
  const DIR_NAME = { e: "east", ne: "north-east", nw: "north-west", w: "west", sw: "south-west", se: "south-east" };
  const el = PlateDraw.el;
  const plateToPx = (q, r) => ({ x: SQ3 * RL * (q + r / 2), y: 1.5 * RL * r });

  let atlas = null;
  let addDir = null, addFrom = null;
  let previewData = null;

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

  function drawContextPlate(p) {
    const o = plateToPx(p.coord[0], p.coord[1]);
    const g = el("g", { transform: `translate(${o.x.toFixed(1)} ${o.y.toFixed(1)})`, opacity: "0.86" }, gAtlas);

    for (const h of geo) {
      el("polygon", {
        points: HexGeo.hexCorners(h.x, h.y, SIZE),
        fill: terrainColor(p.terrain[h.sub] || p.default_terrain),
        stroke: "rgba(0,0,0,0.14)", "stroke-width": 1,
      }, g);
    }
    for (const ln of (p.lines || [])) {
      const pts = ln.path.map(sub => pd.hexBySub.get(sub)).filter(Boolean);
      if (pts.length < 2) continue;
      const st = pd.lineStyle(ln.type);
      const attrs = { d: smoothPath(pts), fill: "none", stroke: st.color, "stroke-width": st.width, "stroke-linecap": "round" };
      if (st.dash) attrs["stroke-dasharray"] = st.dash;
      el("path", attrs, g);
    }
    for (const [sub, c] of Object.entries(p.features || {})) {
      const h = pd.hexBySub.get(sub);
      if (h && c.feature) PlateDraw.drawIcon(g, c.feature.type, h.x, h.y, 1);
    }

    el("polygon", {
      points: HexGeo.plateCorners(RL + SIZE * 0.2), fill: "none",
      stroke: "#3f5c56", "stroke-width": 3, "stroke-linejoin": "round",
    }, g);

    const label = el("text", {
      "text-anchor": "middle", y: -(RL - SIZE * 0.55), "font-size": 34,
      "font-family": "'IM Fell English SC',serif", fill: "rgba(43,43,35,0.5)",
    }, g);
    label.textContent = `${p.id}${p.name ? " · " + p.name : ""}`;

    const title = document.createElementNS(SVGNS, "title");
    title.textContent = `Go to plate ${p.id}${p.name ? " (" + p.name + ")" : ""}`;
    g.appendChild(title);

    context.push({ kind: "plate", id: p.id, x: o.x, y: o.y });
  }

  function drawSlot(slot) {
    const o = plateToPx(slot.coord[0], slot.coord[1]);
    const g = el("g", { transform: `translate(${o.x.toFixed(1)} ${o.y.toFixed(1)})`, class: "slot" }, gAtlas);

    el("polygon", {
      points: HexGeo.plateCorners(RL - SIZE * 0.25), fill: "rgba(233,226,207,0.06)",
      stroke: "#4b6a63", "stroke-width": 4, "stroke-dasharray": "18 14", "stroke-linejoin": "round",
    }, g);
    const plus = el("text", {
      "text-anchor": "middle", y: 46, "font-size": 132, "font-weight": 700,
      "font-family": "'Alegreya Sans',sans-serif", fill: "#4b6a63",
    }, g);
    plus.textContent = "+";
    const cap = el("text", {
      "text-anchor": "middle", y: 104, "font-size": 30, "letter-spacing": "4",
      "font-family": "'IBM Plex Mono',monospace", fill: "#4b6a63",
    }, g);
    cap.textContent = "ADD 36-MI HEX";

    const title = document.createElementNS(SVGNS, "title");
    title.textContent = `Add a new 36-mile hex ${DIR_NAME[slot.dir]} of plate ${slot.from}`;
    g.appendChild(title);

    slots.push({ kind: "slot", from: slot.from, dir: slot.dir, x: o.x, y: o.y });
  }

  function renderAtlas(a) {
    gAtlas.textContent = "";
    context = []; slots = [];
    for (const p of a.plates) if (p.id !== plateId) drawContextPlate(p);
    for (const slot of a.empty) drawSlot(slot);
    const problems = [];
    if (a.orphans && a.orphans.length) problems.push(`${a.orphans.length} plate(s) not linked to this map`);
    if (a.dangling && a.dangling.length) problems.push(`${a.dangling.length} neighbour link(s) point at a missing plate`);
    if (a.conflicts && a.conflicts.length) problems.push(`${a.conflicts.length} inconsistent neighbour link(s)`);
    if (problems.length) setStatus(problems.join(" · "), "err");
  }

  /*
   * Hit-testing happens off the pointer stream: pointerdown calls
   * preventDefault() and sets pointer capture, which suppresses `click`
   * entirely for anything inside the SVG.
   */
  function atlasAt(clientX, clientY) {
    const wx = (clientX - tx) / s, wy = (clientY - ty) / s;
    for (const t of slots) if (HexGeo.insidePlate(wx - t.x, wy - t.y, RL)) return t;
    for (const c of context) if (HexGeo.insidePlate(wx - c.x, wy - c.y, RL)) return c;
    return null;
  }

  function gotoPlate(id) {
    if (dirtyTerrain || dirtyLines) { if (!confirm("You have unsaved changes. Leave this plate?")) return; }
    location.search = "?plate=" + encodeURIComponent(id);
  }

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
    $("addModal").hidden = false;
    $("addName").focus();
    rollPreview();
  }

  function closeAdd() { $("addModal").hidden = true; addDir = null; addFrom = null; previewData = null; }

  function addBody() {
    return {
      from: addFrom,
      dir: addDir,
      name: $("addName").value.trim() || undefined,
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
      if (!body.seed) body.seed = `${addFrom}-${addDir}-${Math.random().toString(36).slice(2, 8)}`;
      $("addSeed").value = body.seed;
      previewData = await post("/api/plate/preview", body);
      drawPreview(previewData);
      const total = Object.values(previewData.counts).reduce((a, b) => a + b, 0);
      const mix = Object.entries(previewData.counts).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${(model.registry.terrain[k] || {}).label || k} ${Math.round(v / total * 100)}%`).join(" · ");
      $("addStats").textContent = previewData.edge_seeds
        ? `${mix} — ${previewData.edge_seeds} border hexes matched to neighbours`
        : mix;
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
      const type = data.terrain[h.sub] || data.default_terrain;
      const poly = document.createElementNS(SVGNS, "polygon");
      poly.setAttribute("points", HexGeo.hexCorners(h.x, h.y, SIZE));
      poly.setAttribute("fill", (T[type] || {}).color || "#ccc");
      poly.setAttribute("stroke", "rgba(0,0,0,0.14)");
      poly.setAttribute("stroke-width", "1");
      svgEl.appendChild(poly);
    }
    const frame = document.createElementNS(SVGNS, "polygon");
    frame.setAttribute("points", HexGeo.plateCorners(RL + SIZE * 0.2));
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "#2e6f6a");
    frame.setAttribute("stroke-width", "5");
    frame.setAttribute("stroke-linejoin", "round");
    svgEl.appendChild(frame);
  }

  async function createPlate() {
    if (!previewData) return;
    $("addCreate").disabled = true;
    $("addStats").textContent = "writing…";
    try {
      const res = await post("/api/plate", addBody());
      setStatus(`created plate ${res.id}`, "ok");
      closeAdd();
      location.search = "?plate=" + encodeURIComponent(res.id);
    } catch (e) {
      $("addStats").textContent = "create failed: " + e.message;
      $("addCreate").disabled = false;
    }
  }

  /* ---------- pointer handling ---------- */
  const pointers = new Map();
  let panning = false, painting = false, moved = false, lastPinch = 0;
  function wantPan(e) { return spaceHeld || e.button === 1 || tool === "lines"; }

  svg.addEventListener("pointerdown", e => {
    e.preventDefault();
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
    // navigate or open the new-plate dialog only after the stroke is closed out
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
  function setStatus(msg, kind) { const el = $("status"); el.textContent = msg; el.className = kind || ""; }

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
    } catch (err) { setStatus("save failed: " + err.message, "err"); }
  }
  async function send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "x-editor-token": window.EDITOR_TOKEN },
      body: JSON.stringify(body),
    });
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
    // Lines acts on taps, so a drag there is free to pan — which is why there
    // is no longer a Pan mode. Paint keeps drag for painting; hold Space.
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
