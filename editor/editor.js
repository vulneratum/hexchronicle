/*
 * HexChronicle editor client (Phase 1) — terrain paint brush + Save.
 * Draws the plate with the SAME shared core as the site (PlateDraw), then adds
 * an editing interaction layer: palette (built from theme/terrain.yaml via the
 * server model), paint/pan tools, undo/redo, and a guarded Save.
 */
(function () {
  "use strict";
  const { SIZE, RL, SQ3, hexCorners, pxToAxial } = HexGeo;
  const svg = document.getElementById("map");
  const $ = id => document.getElementById(id);

  let model, geo, byKey, pd, brush, defaultTerrain, plateId;
  let tool = "paint", spaceHeld = false;
  let dirty = false;
  const undoStack = [], redoStack = [];

  fetch("/api/model").then(r => r.json()).then(init).catch(err => setStatus("load failed: " + err, "err"));

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

    buildPalette();
    fitPlate();
    wireTools();
    setStatus("ready");
  }

  /* ---------- palette from the theme registry (never hardcoded) ---------- */
  function buildPalette() {
    const T = model.registry.terrain;
    const box = $("swatches");
    box.textContent = "";
    for (const key of Object.keys(T)) {
      const b = document.createElement("div");
      b.className = "swatch" + (key === defaultTerrain ? " active" : "");
      b.innerHTML = `<i style="background:${T[key].color}"></i><span>${T[key].label}</span><span class="key">${key}</span>`;
      b.addEventListener("click", () => selectBrush(key));
      b.dataset.key = key;
      box.appendChild(b);
    }
    brush = defaultTerrain;
  }
  function selectBrush(key) {
    brush = key;
    for (const el of document.querySelectorAll(".swatch")) el.classList.toggle("active", el.dataset.key === key);
  }

  /* ---------- pan / zoom ---------- */
  let s = 1, tx = 0, ty = 0;
  function applyTransform() {
    pd.world.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
    pd.setNumbersVisible(s >= 0.95);
  }
  function viewSize() { const r = svg.getBoundingClientRect(); return { w: r.width || innerWidth, h: r.height || innerHeight }; }
  function fitPlate() {
    const v = viewSize(), pad = 60;
    s = Math.min(3, Math.max(0.3, Math.min((v.w - 220) / (SQ3 * RL + SIZE * 5), (v.h - 120) / (2 * RL + SIZE * 5))));
    tx = v.w / 2 + 90; ty = v.h / 2 + 30;
    applyTransform();
  }
  window.addEventListener("resize", () => fitPlate());
  function zoomAt(cx, cy, k) {
    const ns = Math.min(3.2, Math.max(0.3, s * k));
    const real = ns / s;
    tx = cx - (cx - tx) * real; ty = cy - (cy - ty) * real; s = ns;
    applyTransform();
  }

  /* ---------- pointer handling: paint vs pan ---------- */
  const pointers = new Map();
  let panning = false, painting = false, lastPinch = 0, curStroke = null;

  function wantPan(e) { return tool === "pan" || spaceHeld || e.button === 1; }

  function hexAt(clientX, clientY) {
    const wx = (clientX - tx) / s, wy = (clientY - ty) / s;
    const a = pxToAxial(wx, wy);
    return byKey.get(a.q + "," + a.r) || null;
  }
  function paintAt(clientX, clientY) {
    const h = hexAt(clientX, clientY);
    if (!h) return;
    const from = model.terrainByNum[h.sub];
    if (from === brush) return;
    if (!(h.sub in curStroke)) curStroke[h.sub] = { sub: h.sub, from };
    curStroke[h.sub].to = brush;
    pd.setTerrain(h.sub, brush);      // recolors the one hex + updates model.terrainByNum
    markDirty();
  }

  svg.addEventListener("pointerdown", e => {
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; lastPinch = Math.hypot(a.x - b.x, a.y - b.y); return; }
    if (wantPan(e)) { panning = true; svg.classList.add("panning"); }
    else { painting = true; curStroke = {}; paintAt(e.clientX, e.clientY); }
  });
  svg.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / lastPinch);
      lastPinch = d; return;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (panning) { tx += dx; ty += dy; applyTransform(); }
    else if (painting) paintAt(e.clientX, e.clientY);
  });
  function endPointer(e) {
    pointers.delete(e.pointerId); lastPinch = 0;
    if (panning && pointers.size === 0) { panning = false; svg.classList.remove("panning"); }
    if (painting && pointers.size === 0) {
      painting = false;
      const changes = Object.values(curStroke).filter(c => c.to !== c.from);
      if (changes.length) { undoStack.push(changes); redoStack.length = 0; updateUndoButtons(); }
      curStroke = null;
    }
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });

  /* ---------- undo / redo ---------- */
  function applyChanges(changes, dir) {
    for (const c of changes) pd.setTerrain(c.sub, dir === "undo" ? c.from : c.to);
  }
  function undo() { const c = undoStack.pop(); if (!c) return; applyChanges(c, "undo"); redoStack.push(c); markDirty(); updateUndoButtons(); }
  function redo() { const c = redoStack.pop(); if (!c) return; applyChanges(c, "redo"); undoStack.push(c); markDirty(); updateUndoButtons(); }
  function updateUndoButtons() { $("undo").disabled = !undoStack.length; $("redo").disabled = !redoStack.length; }

  /* ---------- dirty / save ---------- */
  function markDirty() { dirty = true; $("save").disabled = false; setStatus("unsaved changes"); }
  function setStatus(msg, kind) { const el = $("status"); el.textContent = msg; el.className = kind || ""; }

  function save() {
    if (!dirty) return;
    const overrides = {};
    for (const h of geo) { const t = model.terrainByNum[h.sub]; if (t !== defaultTerrain) overrides[h.sub] = t; }
    setStatus("saving…");
    fetch(`/api/plate/${plateId}/terrain`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-editor-token": window.EDITOR_TOKEN },
      body: JSON.stringify({ default_terrain: defaultTerrain, terrain: overrides }),
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      dirty = false; $("save").disabled = true;
      setStatus(`saved · ${j.overrides} overrides written to plates/${plateId}.yaml`, "ok");
    }).catch(err => setStatus("save failed: " + err.message, "err"));
  }

  /* ---------- tools + keyboard ---------- */
  function setTool(t) {
    tool = t;
    for (const b of document.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === t);
    svg.classList.toggle("tool-pan", t === "pan");
  }
  function wireTools() {
    for (const b of document.querySelectorAll(".tool")) b.addEventListener("click", () => setTool(b.dataset.tool));
    $("undo").addEventListener("click", undo);
    $("redo").addEventListener("click", redo);
    $("fit").addEventListener("click", fitPlate);
    $("save").addEventListener("click", save);
    window.addEventListener("keydown", e => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.code === "Space") { spaceHeld = true; svg.classList.add("tool-pan"); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      else if (e.key === "b" || e.key === "B") setTool("paint");
      else if (e.key === "v" || e.key === "V") setTool("pan");
    });
    window.addEventListener("keyup", e => { if (e.code === "Space") { spaceHeld = false; if (tool !== "pan") svg.classList.remove("tool-pan"); } });
    window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  }
})();
