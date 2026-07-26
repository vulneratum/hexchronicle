/*
 * HexChronicle SITE renderer — interaction layer for the published plate.
 * Drawing is done by the shared core (shared/plate-draw.js); this file only
 * adds pan/zoom, tap-to-open-card, cartouche/legend, and the intro. Reads two
 * globals inlined by the build: HexGeo, WORLD (and uses global PlateDraw).
 *
 * INVENTS NOTHING — every value comes from compiled repo data.
 */
(function () {
  "use strict";
  const { SIZE, RL, SQ3, hexCorners, pxToAxial } = HexGeo;
  const T = WORLD.registry.terrain, F = WORLD.registry.features;

  const geo = HexGeo.buildPlateHexes();
  const byKey = new Map(geo.map(h => [h.key, h]));
  const model = {
    geo,
    plate: WORLD.plate,
    registry: WORLD.registry,
    terrainByNum: WORLD.terrainByNum,
    hexContent: WORLD.hexContent,
    lines: WORLD.lines,
  };

  /* line-feature membership per subhex, for the card */
  const riverSubs = new Set(), roadSubs = new Set();
  for (const ln of WORLD.lines) for (const s of ln.path) (ln.type === "river" ? riverSubs : roadSubs).add(s);

  const svg = document.getElementById("map");
  const pd = PlateDraw.create(svg, model);
  const world = pd.world;
  const addr = h => WORLD.plate.id + "-" + h.sub;

  /* neighbor chips: navigate (only "—" placeholders for now) */
  for (const chip of pd.neighborChips) {
    chip.g.addEventListener("click", ev => {
      ev.stopPropagation();
      if (chip.nid) showToast(`Plate ${chip.nid} — the adjoining plate would load here.`);
      else showToast(`No plate to the ${chip.dir.toUpperCase()} yet. It gets created and numbered when the map grows.`);
    });
  }

  /* ---- pan / zoom ---- */
  let s = 1, tx = 0, ty = 0;
  function applyTransform() {
    world.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
    pd.setNumbersVisible(s >= 0.95);
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
    selEl = PlateDraw.el("polygon", { points: hexCorners(h.x, h.y, SIZE), fill: "none", stroke: "#f3ead0", "stroke-width": 3 }, pd.layers.sel);
    const c = WORLD.hexContent[h.sub] || {};
    const rows = [];
    if (c.feature) {
      const flabel = (F[c.feature.type] && F[c.feature.type].label) || c.feature.type;
      rows.push(`<dt>Feature</dt><dd><b>${esc(c.feature.name)}</b> — ${esc(flabel)}</dd>`);
    }
    const lf = [];
    if (riverSubs.has(h.sub)) lf.push("stream");
    if (roadSubs.has(h.sub)) lf.push("road");
    if (lf.length) rows.push(`<dt>Line features</dt><dd>${lf.join(", ")}</dd>`);
    const chronicle = c.chronicle || [];
    const chron = chronicle.length
      ? chronicle.map(x => `<p><b>${esc(x.date)}</b> — ${esc(x.text)}</p>`).join("")
      : `<p class="empty">Nothing chronicled here yet.</p>`;
    const mem = c.local_memory ? `<h3>Local memory</h3><div class="chron"><p>${esc(c.local_memory)}</p></div>` : "";
    const tspec = T[WORLD.terrainByNum[h.sub]] || { label: WORLD.terrainByNum[h.sub] };
    const srcFile = c.feature || chronicle.length || c.local_memory
      ? `hexes/${addr(h)}.yaml` : `plates/${WORLD.plate.id}.yaml (terrain grid)`;
    openCard(`
      <div class="eyebrow">Hex ${esc(addr(h))} · 3-mile · plate ${esc(WORLD.plate.id)} · #${h.num}</div>
      <h2>${esc((c.feature && c.feature.name) || tspec.label)}</h2>
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

  /* ---- cartouche + legend ---- */
  const PL = WORLD.plate;
  document.getElementById("t-title").textContent = PL.title || PL.name;
  document.getElementById("t-addr").textContent = `36-MILE HEX #${PL.id} · within 432-MILE HEX #${PL.continent_hex}`;
  document.getElementById("t-scale").textContent = `SCALE: ${PL.scale_label}`;
  svg.setAttribute("aria-label", `Atlas plate ${PL.id} — ${PL.name}`);
  document.title = `HexChronicle — Plate ${PL.id} · ${PL.name}`;

  const legend = document.getElementById("legend");
  function chipSVG(kind) {
    const sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sv.setAttribute("width", 14); sv.setAttribute("height", 14); sv.setAttribute("viewBox", "-7 -7 14 14");
    PlateDraw.drawIcon(sv, kind, 0, 0, 0.85);
    return sv;
  }
  const present = new Set(geo.map(h => WORLD.terrainByNum[h.sub]));
  for (const key of Object.keys(T)) {
    if (!present.has(key)) continue;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<i style="background:${T[key].color}"></i>${esc(T[key].label)}`;
    legend.appendChild(chip);
  }
  const presentFeatures = new Set(Object.values(WORLD.hexContent).filter(c => c.feature).map(c => c.feature.type));
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
    <h2>Plate ${esc(PL.id)} — ${esc(PL.name)}</h2>
    <div class="chron">
      <p><b>One atlas hex is the page.</b> This is 36-mile hex #${esc(PL.id)} inside 432-mile hex #${esc(PL.continent_hex)}, drawn as 3-mile subhexes (1 league), numbered row by row.</p>
      <p><b>Tap any hex</b> for its card — addresses like <b>${esc(PL.id)}-104</b> come straight from the nesting. Everything you see was compiled from the repo's data files, not generated in the browser.</p>
      <p><b>The teal chips</b> on each edge are the six adjoining plates; none exist yet, so they show “—”.</p>
    </div>
    <div class="actions"><button id="introGo">Explore the plate</button></div>
  `);
  document.getElementById("introGo").addEventListener("click", closeCard);
  applyTransform();
})();
