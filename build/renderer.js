/*
 * HexChronicle plate renderer — browser-side SVG drawn from compiled
 * world-state (README §3). Static, no server. Reads two globals:
 *   HexGeo  — shared geometry/numbering (build/geometry.js)
 *   WORLD   — the compiled plate, inlined by the build (build/build.js)
 *
 * Unlike the demo prototype, this renderer INVENTS NOTHING: terrain,
 * features, chronicle, and line features all come from committed data files.
 */
(function () {
  "use strict";
  const { SIZE, RL, SQ3, hexCorners, plateCorners, pxToAxial } = HexGeo;
  const T = WORLD.registry.terrain;   // key -> {color,label}
  const F = WORLD.registry.features;  // key -> {label}

  /* ---- geometry: the canonical subhex layout, indexed by number ---- */
  const geo = HexGeo.buildPlateHexes();
  const bySub = new Map(geo.map(h => [h.sub, h]));
  const byKey = new Map(geo.map(h => [h.key, h]));

  /* merge compiled content onto each geometry hex */
  for (const h of geo) {
    h.terrain = WORLD.terrainByNum[h.sub] || WORLD.plate.default_terrain;
    const c = WORLD.hexContent[h.sub];
    h.feature = c && c.feature ? c.feature : null;      // {type,name}
    h.name = h.feature ? h.feature.name : null;
    h.chronicle = c && c.chronicle ? c.chronicle : [];
    h.memory = c && c.local_memory ? c.local_memory : null;
    h.river = false; h.road = false;
  }
  /* flag line-feature membership for the card */
  for (const ln of WORLD.lines) for (const sub of ln.path) {
    const h = bySub.get(sub); if (!h) continue;
    if (ln.type === "river") h.river = true; else h.road = true;
  }

  const addr = h => WORLD.plate.id + "-" + h.sub;

  /* ---- svg scaffold ---- */
  const SVGNS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("map");
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const world = el("g", {}, svg);
  const gFill = el("g", {}, world);
  const gWater = el("g", {}, world);
  const gRoad = el("g", {}, world);
  const gIcon = el("g", {}, world);
  const gNum = el("g", { style: "transition:opacity .3s" }, world);
  const gFrame = el("g", {}, world);
  const gSel = el("g", {}, world);

  /* ---- terrain fills ---- */
  for (const h of geo) {
    const spec = T[h.terrain] || { color: "#cccccc" };
    el("polygon", {
      points: hexCorners(h.x, h.y, SIZE),
      fill: spec.color, stroke: "rgba(0,0,0,0.16)", "stroke-width": 1
    }, gFill);
  }

  /* ---- line features (paths of subhex centers) ---- */
  function smoothPath(pts) {
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const L = pts[pts.length - 1];
    d += ` L ${L.x.toFixed(1)} ${L.y.toFixed(1)}`;
    return d;
  }
  for (const ln of WORLD.lines) {
    const pts = ln.path.map(s => bySub.get(s)).filter(Boolean);
    if (pts.length < 2) continue;
    if (ln.type === "river") {
      el("path", { d: smoothPath(pts), fill: "none", stroke: "#7ea6c9",
        "stroke-width": 3, "stroke-linecap": "round", opacity: 0.9 }, gWater);
    } else {
      el("path", { d: smoothPath(pts), fill: "none", stroke: "#6b5138",
        "stroke-width": 2.4, "stroke-linecap": "round" }, gRoad);
    }
  }

  /* ---- feature icons (same vocabulary as the prototype) ---- */
  function drawIcon(parent, feature, cx, cy, scale) {
    const g = el("g", { transform: `translate(${cx} ${cy}) scale(${scale})` }, parent);
    if (feature === "village") {
      el("circle", { r: 4.6, fill: "none", stroke: "#2b2b23", "stroke-width": 2 }, g);
    } else if (feature === "town") {
      el("circle", { r: 6, fill: "none", stroke: "#2b2b23", "stroke-width": 2 }, g);
      el("circle", { r: 2.6, fill: "none", stroke: "#2b2b23", "stroke-width": 1.6 }, g);
    } else if (feature === "city") {
      el("circle", { r: 7, fill: "#f0ead2", stroke: "#2b2b23", "stroke-width": 2.2 }, g);
      el("circle", { r: 2.6, fill: "#2b2b23" }, g);
    } else if (feature === "burned") {
      el("circle", { r: 4.6, fill: "none", stroke: "#2c2622", "stroke-width": 2 }, g);
      el("path", { d: "M 0 -12 C 3 -8 4.5 -7 3.5 -3.5 C 2.5 -1 -2.5 -1 -3.5 -3.5 C -4.5 -7 -3 -8 0 -12 Z", fill: "#b04a2e" }, g);
    } else if (feature === "ruin") {
      el("rect", { x: -6, y: -5, width: 3.4, height: 11, fill: "#5c5142" }, g);
      el("rect", { x: 2, y: -2, width: 3.4, height: 8, fill: "#5c5142", transform: "rotate(14 3.7 2)" }, g);
    } else if (feature === "dungeon") {
      el("path", { d: "M -6 6 L -6 -2 A 6 6 0 0 1 6 -2 L 6 6 Z", fill: "#38322b" }, g);
      el("path", { d: "M -2.2 6 L -2.2 0 A 2.2 2.2 0 0 1 2.2 0 L 2.2 6 Z", fill: "#171412" }, g);
    } else if (feature === "lair") {
      el("rect", { x: -5.4, y: -5.4, width: 10.8, height: 10.8, fill: "#f0ead2", stroke: "#9e3d34", "stroke-width": 2, transform: "rotate(45)" }, g);
      const t = el("text", { "text-anchor": "middle", y: 3.4, "font-size": 9, "font-weight": 700, fill: "#9e3d34", "font-family": "'Alegreya Sans',sans-serif" }, g);
      t.textContent = "M";
    }
    return g;
  }
  for (const h of geo) if (h.feature) h.iconEl = drawIcon(gIcon, h.feature.type, h.x, h.y, 1);

  /* name the settlements the plate calls out (city + towns) */
  for (const h of geo) {
    if (!h.feature) continue;
    if (h.feature.type === "city" || h.feature.type === "town") {
      const t = el("text", {
        x: h.x, y: h.y + 22, "text-anchor": "middle",
        "font-family": "'IM Fell English SC',serif",
        "font-size": h.feature.type === "city" ? 15 : 12, fill: "#2b2b23"
      }, gIcon);
      t.textContent = h.name;
    }
  }

  /* ---- subhex numbers (shown past a zoom threshold) ---- */
  for (const h of geo) {
    const t = el("text", {
      x: h.x, y: h.y - SIZE * 0.42, "text-anchor": "middle",
      "font-family": "'IBM Plex Mono',monospace", "font-size": 8.5, fill: "rgba(43,43,35,0.6)"
    }, gNum);
    t.textContent = h.num;
  }

  /* ---- plate frame + six neighbor chips ---- */
  el("polygon", { points: plateCorners(RL + SIZE * 0.2), fill: "none",
    stroke: "#2e6f6a", "stroke-width": 4, "stroke-linejoin": "round" }, gFrame);
  const NEI = [
    { dir: "e",  ang: 0 }, { dir: "se", ang: 60 }, { dir: "sw", ang: 120 },
    { dir: "w",  ang: 180 }, { dir: "nw", ang: 240 }, { dir: "ne", ang: 300 }
  ];
  for (const n of NEI) {
    const a = Math.PI / 180 * n.ang, R = RL + SIZE * 1.35;
    const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
    const g = el("g", { transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`, style: "cursor:pointer" }, gFrame);
    el("polygon", { points: hexCorners(0, 0, 20), fill: "#e9e2cf", stroke: "#2e6f6a", "stroke-width": 2.5 }, g);
    const t1 = el("text", { "text-anchor": "middle", y: -2, "font-size": 6.4, fill: "#2e6f6a", "font-family": "'IBM Plex Mono',monospace" }, g);
    t1.textContent = "36-MI HEX";
    const nid = WORLD.plate.neighbors ? WORLD.plate.neighbors[n.dir] : null;
    const t2 = el("text", { "text-anchor": "middle", y: 9, "font-size": 11, "font-weight": 700, fill: "#2e6f6a", "font-family": "'Alegreya Sans',sans-serif" }, g);
    t2.textContent = nid ? nid : "—";
    g.addEventListener("click", ev => {
      ev.stopPropagation();
      if (nid) showToast(`Plate ${nid} — the adjoining plate would load here.`);
      else showToast(`No plate to the ${n.dir.toUpperCase()} yet. It gets created and numbered when the map grows.`);
    });
  }

  /* ---- pan / zoom ---- */
  let s = 1, tx = 0, ty = 0;
  function applyTransform() {
    world.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
    gNum.style.opacity = s >= 0.95 ? 1 : 0;    // numbers past a zoom threshold (README §3)
  }
  function viewSize() {
    const r = svg.getBoundingClientRect();
    return { w: r.width || innerWidth, h: r.height || innerHeight };
  }
  let interacted = false;
  function fitPlate() {
    const v = viewSize(), pad = 60;
    s = Math.min(3, Math.max(0.3, Math.min(
      (v.w - pad) / (SQ3 * RL + SIZE * 5),
      (v.h - 170) / (2 * RL + SIZE * 5)
    )));
    tx = v.w / 2; ty = v.h / 2 + 14;
    applyTransform();
  }
  fitPlate();
  window.addEventListener("load", fitPlate);
  window.addEventListener("resize", () => { if (!interacted) fitPlate(); });
  window.addEventListener("orientationchange", () => setTimeout(fitPlate, 250));
  requestAnimationFrame(fitPlate);
  document.getElementById("fitBtn").addEventListener("click", () => { closeCard(); interacted = false; fitPlate(); });

  const pointers = new Map();
  let movedFlag = false, lastPinch = 0;
  svg.addEventListener("pointerdown", e => {
    e.preventDefault();                 // stop drag-/double-click text selection on the plate
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) movedFlag = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  svg.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pointers.size === 1) {
      if (Math.hypot(dx, dy) > 4) { movedFlag = true; interacted = true; }
      tx += dx; ty += dy; p.x = e.clientX; p.y = e.clientY;
      applyTransform();
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0) { zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / lastPinch); movedFlag = true; }
      lastPinch = d;
    }
  });
  svg.addEventListener("pointerup", e => {
    if (pointers.size === 1 && !movedFlag) tapAt(e.clientX, e.clientY);
    pointers.delete(e.pointerId); lastPinch = 0;
  });
  svg.addEventListener("pointercancel", e => pointers.delete(e.pointerId));
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
  }, { passive: false });
  function zoomAt(cx, cy, k) {
    interacted = true;
    const ns = Math.min(3.2, Math.max(0.3, s * k));
    const real = ns / s;
    tx = cx - (cx - tx) * real;
    ty = cy - (cy - ty) * real;
    s = ns;
    applyTransform();
  }

  /* ---- tap + card ---- */
  let selEl = null;
  function clearSel() { if (selEl) { selEl.remove(); selEl = null; } }
  function esc(x) { return String(x == null ? "" : x).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function tapAt(cx, cy) {
    const wx = (cx - tx) / s, wy = (cy - ty) / s;
    const a = pxToAxial(wx, wy);
    const h = byKey.get(a.q + "," + a.r);
    if (!h) { closeCard(); return; }
    clearSel();
    selEl = el("polygon", { points: hexCorners(h.x, h.y, SIZE), fill: "none", stroke: "#f3ead0", "stroke-width": 3 }, gSel);
    const rows = [];
    if (h.feature) {
      const flabel = (F[h.feature.type] && F[h.feature.type].label) || h.feature.type;
      rows.push(`<dt>Feature</dt><dd><b>${esc(h.name)}</b> — ${esc(flabel)}</dd>`);
    }
    const lf = [];
    if (h.river) lf.push("stream");
    if (h.road) lf.push("road");
    if (lf.length) rows.push(`<dt>Line features</dt><dd>${lf.join(", ")}</dd>`);
    const chron = h.chronicle.length
      ? h.chronicle.map(x => `<p><b>${esc(x.date)}</b> — ${esc(x.text)}</p>`).join("")
      : `<p class="empty">Nothing chronicled here yet.</p>`;
    const mem = h.memory ? `<h3>Local memory</h3><div class="chron"><p>${esc(h.memory)}</p></div>` : "";
    const tspec = T[h.terrain] || { label: h.terrain };
    const srcFile = h.feature || h.chronicle.length || h.memory
      ? `hexes/${addr(h)}.yaml` : `plates/${WORLD.plate.id}.yaml (terrain grid)`;
    openCard(`
      <div class="eyebrow">Hex ${esc(addr(h))} · 3-mile · plate ${esc(WORLD.plate.id)} · #${h.num}</div>
      <h2>${esc(h.name || tspec.label)}</h2>
      <dl class="rows">
        <dt>Terrain</dt><dd>${esc(tspec.label)}</dd>
        ${rows.join("")}
        <dt>Canton</dt><dd>${esc(WORLD.plate.canton)}, ${esc(WORLD.plate.realm)}</dd>
      </dl>
      <h3>Chronicle</h3><div class="chron">${chron}</div>
      ${mem}
      <h3>Source</h3>
      <pre>${esc(srcFile)}</pre>
    `);
  }
  const card = document.getElementById("card"), cardBody = document.getElementById("cardBody");
  function openCard(html) { cardBody.innerHTML = html; card.classList.add("open"); }
  function closeCard() { card.classList.remove("open"); clearSel(); }
  document.getElementById("cardClose").addEventListener("click", closeCard);

  /* ---- toast ---- */
  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => t.classList.remove("show"), 6000);
  }

  /* ---- cartouche + legend, populated from the compiled plate ---- */
  const P = WORLD.plate;
  document.getElementById("t-title").textContent = P.title || P.name;
  document.getElementById("t-addr").textContent =
    `36-MILE HEX #${P.id} · within 432-MILE HEX #${P.continent_hex}`;
  document.getElementById("t-scale").textContent = `SCALE: ${P.scale_label}`;
  svg.setAttribute("aria-label", `Atlas plate ${P.id} — ${P.name}`);
  document.title = `HexChronicle — Plate ${P.id} · ${P.name}`;

  const legend = document.getElementById("legend");
  function chipSVG(kind) {
    const sv = document.createElementNS(SVGNS, "svg");
    sv.setAttribute("width", 14); sv.setAttribute("height", 14); sv.setAttribute("viewBox", "-7 -7 14 14");
    drawIcon(sv, kind, 0, 0, 0.85);
    return sv;
  }
  // terrain swatches: only the types actually present on this plate
  const present = new Set(geo.map(h => h.terrain));
  for (const key of Object.keys(T)) {
    if (!present.has(key)) continue;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<i style="background:${T[key].color}"></i>${esc(T[key].label)}`;
    legend.appendChild(chip);
  }
  const presentFeatures = new Set(geo.filter(h => h.feature).map(h => h.feature.type));
  for (const key of Object.keys(F)) {
    if (!presentFeatures.has(key)) continue;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.appendChild(chipSVG(key));
    chip.appendChild(document.createTextNode(F[key].label));
    legend.appendChild(chip);
  }

  /* ---- intro card ---- */
  openCard(`
    <div class="eyebrow">Atlas plate view</div>
    <h2>Plate ${esc(P.id)} — ${esc(P.name)}</h2>
    <div class="chron">
      <p><b>One atlas hex is the page.</b> This is 36-mile hex #${esc(P.id)} inside 432-mile hex #${esc(P.continent_hex)}, drawn as 3-mile subhexes (1 league), numbered row by row.</p>
      <p><b>Tap any hex</b> for its card — addresses like <b>${esc(P.id)}-104</b> come straight from the nesting. Everything you see was compiled from the repo's data files, not generated in the browser.</p>
      <p><b>The teal chips</b> on each edge are the six adjoining plates; none exist yet, so they show “—”.</p>
    </div>
    <div class="actions"><button id="introGo">Explore the plate</button></div>
  `);
  document.getElementById("introGo").addEventListener("click", closeCard);
  applyTransform();
})();
