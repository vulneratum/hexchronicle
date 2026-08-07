/*
 * HexChronicle SITE renderer — the interaction layer for the published map.
 *
 * ONE CONTINUOUS MAP, no plate to choose. Drawing is done by the shared atlas
 * (shared/plate-draw.js — PlateDraw.createAtlas), exactly as in the editor, so
 * the two can never drift: merged-path terrain, smoothed shorelines, the
 * atlas-wide line network, feature anchors, seam ownership and viewport culling
 * all come from that one module. This file adds pan/zoom, tap-to-open-card, the
 * legend, and deep links.
 *
 * IT FETCHES WHAT IT SHOWS. world/atlas.json is the summary of every 36-mile
 * hex; world/plate-NNNN.json is one plate's interior, pulled in only when that
 * plate scrolls into view. A visitor with the whole continent on screen still
 * only downloads the plates they are actually looking at.
 *
 * INVENTS NOTHING — every value comes from compiled repo data.
 */
(function () {
  "use strict";
  const { SIZE, RL } = HexGeo;
  const svg = document.getElementById("map");
  const $ = id => document.getElementById(id);

  let atlas = null, registry = null, summary = null;
  const detail = new Map();                 // id -> plate interior (null while loading)
  const fetching = new Map();
  let selected = null;                      // { plateId, sub } — always the OWNER

  /*
   * Substituted by build/build.js with a hash of the world data this exact
   * shell was built against. Every fetch for world/*.json carries it as
   * ?v=, so a stale cached copy of index.html can never pair with a plate
   * or atlas file from a different build, and a fresh build always asks the
   * browser for a URL it has never cached.
   */
  const DATA_VERSION = "__DATA_VERSION__";

  const esc = x => String(x == null ? "" : x).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });

  boot();

  async function boot() {
    let a;
    try { a = await getJSON(`world/atlas.json?v=${DATA_VERSION}`); }
    catch (err) { showToast("The map could not be loaded: " + err.message); return; }
    summary = a;
    registry = a.registry;

    atlas = PlateDraw.createAtlas(svg, {
      registry,
      frameStroke: "#2e6f6a",
      stateOf: id => detail.get(id) || null,
      request: id => { ensureDetail(id).catch(() => {}); },
      viewportRect,
    });

    /*
     * FRAME FIRST, THEN POPULATE. setPlates runs the first viewport pass, and
     * that pass is what decides which plate interiors get fetched — so the
     * camera has to be pointing at the right place before it happens. Arriving
     * at #0003-135 then downloads the plates around that hex, not the continent.
     */
    const target = hashTarget();
    if (target) frameHex(target, 1.4); else frameAll();
    atlas.setView(tx, ty, s);
    atlas.setPlates(a.plates, []);

    buildLegend();
    wire();
    if (!openFromHash()) openIntro();
    window.addEventListener("hashchange", () => openFromHash());
  }

  function ensureDetail(id) {
    if (detail.has(id)) return Promise.resolve(detail.get(id));
    const inflight = fetching.get(id);
    if (inflight) return inflight;
    const p = getJSON(`world/plate-${id}.json?v=${DATA_VERSION}`).then(d => {
      // the atlas reads terrain by subhex with a default fallback, like the editor
      detail.set(id, {
        id: d.id, name: d.name, title: d.title, canton: d.canton, realm: d.realm,
        summary: d.summary, continent_hex: d.continent_hex, scale_label: d.scale_label,
        defaultTerrain: d.default_terrain,
        terrain: d.terrain, lines: d.lines, hexes: d.hexes,
      });
      fetching.delete(id);
      scheduleViewport();
      return detail.get(id);
    });
    p.catch(() => fetching.delete(id));
    fetching.set(id, p);
    return p;
  }

  /* ---- camera ---- */
  let s = 1, tx = 0, ty = 0, interacted = false;
  function viewSize() { const r = svg.getBoundingClientRect(); return { w: r.width || innerWidth, h: r.height || innerHeight }; }
  function viewportRect() {
    const v = viewSize();
    return { xmin: (0 - tx) / s, xmax: (v.w - tx) / s, ymin: (0 - ty) / s, ymax: (v.h - ty) / s };
  }
  function applyTransform() { atlas.setView(tx, ty, s); scheduleViewport(); }
  let vpScheduled = false;
  function scheduleViewport() {
    if (vpScheduled) return;
    vpScheduled = true;
    requestAnimationFrame(() => { vpScheduled = false; atlas.update(); drawSelection(); });
  }
  /* every plate's world position, from the summary alone — needed before the
   * atlas has been populated, because the framing decides what gets fetched */
  function summaryBounds() {
    const pts = summary.plates.map(p => HexGeo.plateToPx(p.coord[0], p.coord[1]));
    if (!pts.length) pts.push({ x: 0, y: 0 });
    return {
      minX: Math.min(...pts.map(p => p.x)) - RL - SIZE, maxX: Math.max(...pts.map(p => p.x)) + RL + SIZE,
      minY: Math.min(...pts.map(p => p.y)) - RL - SIZE, maxY: Math.max(...pts.map(p => p.y)) + RL + SIZE,
    };
  }
  function frameAll() {
    const v = viewSize(), b = summaryBounds(), pad = 40;
    const availW = Math.max(200, v.w - pad * 2), availH = Math.max(200, v.h - 170);
    s = Math.min(3, Math.max(0.03, Math.min(availW / (b.maxX - b.minX), availH / (b.maxY - b.minY))));
    tx = v.w / 2 - ((b.minX + b.maxX) / 2) * s;
    ty = v.h / 2 + 8 - ((b.minY + b.maxY) / 2) * s;
  }
  function frameHex(hit, zoom) {
    const p = summary.plates.find(x => x.id === hit.plateId);
    const h = HexGeo.buildPlateHexes().find(x => x.sub === hit.sub);
    if (!p || !h) { frameAll(); return; }
    const o = HexGeo.plateToPx(p.coord[0], p.coord[1]);
    const v = viewSize();
    s = zoom;
    tx = v.w / 2 - (o.x + h.x) * s;
    ty = v.h / 2 - 60 - (o.y + h.y) * s;
    interacted = true;
  }
  function fitAll() { frameAll(); applyTransform(); }
  function zoomAt(cx, cy, k) {
    interacted = true;
    const ns = Math.min(3.2, Math.max(0.03, s * k)), real = ns / s;
    tx = cx - (cx - tx) * real; ty = cy - (cy - ty) * real; s = ns;
    applyTransform();
  }
  /* centre one hex on screen, for a deep link */
  function centreOn(plateId, sub, zoom) {
    const p = atlas.worldOf(plateId, sub);
    if (!p) return false;
    const v = viewSize();
    s = zoom || Math.max(s, 1.2);
    tx = v.w / 2 - p.x * s;
    ty = v.h / 2 - 60 - p.y * s;
    interacted = true;
    applyTransform();
    return true;
  }

  /* ---- pointer input: every interaction routes through the hit test ---- */
  const pointers = new Map();
  let movedFlag = false, lastPinch = 0;
  svg.addEventListener("pointerdown", e => {
    e.preventDefault();                 // suppresses `click` on SVG children
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
  svg.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });

  /* ---- selection + card ---- */
  function drawSelection() {
    atlas.layers.ui.textContent = "";
    if (!selected) return;
    const p = atlas.worldOf(selected.plateId, selected.sub);
    if (!p) return;
    PlateDraw.el("polygon", {
      points: HexGeo.hexCorners(p.x, p.y, SIZE), fill: "none",
      stroke: "#f3ead0", "stroke-width": 3, "stroke-linejoin": "round",
    }, atlas.layers.ui);
  }

  function tapAt(cx, cy) {
    const w = { x: (cx - tx) / s, y: (cy - ty) / s };
    const hit = atlas.hexAt(w.x, w.y);
    if (!hit) { closeCard(); return; }
    selectHex(hit, true);
  }

  /*
   * One click, one card. `hit` is already the OWNER of the position, so a hex on
   * a 36-mile boundary reads the same whichever side you clicked from.
   */
  function selectHex(hit, setHash) {
    selected = hit;
    drawSelection();
    if (setHash) {
      const addr = atlas.own.addressOf(hit.plateId, hit.sub);
      if (location.hash !== "#" + addr) history.replaceState(null, "", "#" + addr);
    }
    const st = detail.get(hit.plateId);
    if (!st) { openCard(`<div class="eyebrow">Loading…</div><h2>${esc(atlas.own.addressOf(hit.plateId, hit.sub))}</h2>`); ensureDetail(hit.plateId).then(() => { if (selected === hit) renderCard(hit); }).catch(() => {}); return; }
    renderCard(hit);
  }

  function renderCard(hit) {
    const st = detail.get(hit.plateId);
    if (!st) return;
    const T = registry.terrain, F = registry.features;
    const addr = atlas.own.addressOf(hit.plateId, hit.sub);
    const c = (st.hexes || {})[hit.sub] || {};
    const tspec = T[st.terrain[hit.sub]] || { label: st.terrain[hit.sub] };

    const rows = [];
    if (c.feature) {
      const flabel = (F[c.feature.type] && F[c.feature.type].label) || c.feature.type;
      rows.push(`<dt>Feature</dt><dd><b>${esc(c.feature.name || c.name || "")}</b>${c.feature.name || c.name ? " — " : ""}${esc(flabel)}</dd>`);
    }
    const lf = linesThrough(addr);
    if (lf.length) rows.push(`<dt>Line features</dt><dd>${esc(lf.join(", "))}</dd>`);
    const shared = atlas.own.sharersOf(hit.plateId, hit.sub).filter(x => x.plateId !== hit.plateId);
    if (shared.length) rows.push(`<dt>On the boundary of</dt><dd>${esc(shared.map(x => x.plateId).join(", "))}</dd>`);

    const chronicle = c.chronicle || [];
    const chron = chronicle.length
      ? chronicle.map(x => `<p><b>${esc(x.date)}</b> — ${esc(x.text)}</p>`).join("")
      : `<p class="empty">Nothing chronicled here yet.</p>`;
    const mem = c.local_memory ? `<h3>Local memory</h3><div class="chron"><p>${esc(c.local_memory)}</p></div>` : "";
    const srcFile = (c.feature || chronicle.length || c.local_memory)
      ? `hexes/${addr}.yaml` : `plates/${hit.plateId}.yaml (terrain grid)`;

    openCard(`
      <div class="eyebrow">Hex ${esc(addr)} · 3-mile · in 36-mile hex ${esc(hit.plateId)}${st.name ? " · " + esc(st.name) : ""}</div>
      <h2>${esc(c.name || (c.feature && c.feature.name) || tspec.label)}</h2>
      <dl class="rows">
        <dt>Terrain</dt><dd>${esc(tspec.label)}</dd>
        ${rows.join("")}
        <dt>Canton</dt><dd>${esc(st.canton || "—")}${st.realm ? ", " + esc(st.realm) : ""}</dd>
      </dl>
      <h3>Chronicle</h3><div class="chron">${chron}</div>
      ${mem}
      <h3>Source</h3>
      <pre>${esc(srcFile)}</pre>
    `);
  }

  /* every line through this world position, across every loaded plate */
  function linesThrough(addr) {
    const out = new Set();
    for (const [id, st] of detail) {
      for (const ln of (st.lines || [])) {
        for (const e of ln.path) {
          const a = HexGeo.parseAddr(e);
          if (!a) continue;
          if (atlas.own.addressOf(a.plate || id, a.sub) === addr) {
            out.add(((registry.lines || {})[ln.type] || {}).label || ln.type);
          }
        }
      }
    }
    return [...out];
  }

  /* ---- deep link: #0003-135 opens that hex ---- *
   * The address in the link is resolved to its OWNER, so a boundary hex shared
   * by two 36-mile hexes opens the same card whichever of its two names was
   * shared — #0003-135 and #0002-001 land on exactly the same place. */
  function hashTarget() {
    const m = /^#(\d{4})-(\d{3})$/.exec(location.hash || "");
    if (!m) return null;
    if (!summary.plates.some(p => p.id === m[1])) return null;
    return { plateId: m[1], sub: m[2] };
  }
  function openFromHash() {
    const t = hashTarget();
    if (!t) {
      if (location.hash) showToast(`No hex ${location.hash.slice(1)} on this map.`);
      return false;
    }
    const hit = atlas.own.ownerOf(t.plateId, t.sub);
    centreOn(hit.plateId, hit.sub, Math.max(s, 1.4));
    selectHex(hit, false);      // the interior may still be in flight; the card fills in
    return true;
  }

  const card = $("card"), cardBody = $("cardBody");
  function openCard(html) { cardBody.innerHTML = html; card.classList.add("open"); }
  function closeCard() {
    card.classList.remove("open");
    selected = null; drawSelection();
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }

  function openIntro() {
    const n = summary.plates.length;
    openCard(`
      <div class="eyebrow">The atlas</div>
      <h2>${esc(n)} 36-mile hex${n === 1 ? "" : "es"}, one continuous map</h2>
      <div class="chron">
        <p><b>Click any hex</b> for its card. Every 3-mile hex has a permanent address like <b>0001-104</b>, which comes straight from the nesting — 3-mile hexes inside 36-mile hexes inside 432-mile hexes.</p>
        <p><b>A hex on a boundary belongs to one of its two 36-mile hexes</b>, so it reads the same from either side.</p>
        <p>Everything you see was compiled from the repo's data files, not generated in the browser. Drag to pan, scroll or pinch to zoom.</p>
      </div>
      <div class="actions"><button id="introGo">Explore the map</button></div>
    `);
    const go = $("introGo");
    if (go) go.addEventListener("click", closeCard);
  }

  /* ---- chrome ---- */
  function wire() {
    $("cardClose").addEventListener("click", closeCard);
    $("fitBtn").addEventListener("click", () => { closeCard(); interacted = false; fitAll(); });
    window.addEventListener("resize", () => { if (!interacted) fitAll(); });
    window.addEventListener("orientationchange", () => setTimeout(() => { if (!interacted) fitAll(); }, 250));
    document.title = "HexChronicle — the atlas";
    svg.setAttribute("aria-label", `Atlas — ${summary.plates.length} 36-mile hexes`);
    const first = summary.plates[0] || {};
    $("t-title").textContent = first.realm ? `The realm of ${first.realm}` : "The atlas";
    $("t-addr").textContent = `${summary.plates.length} 36-MILE HEXES · ${summary.plates.length * 157} SUBHEXES`;
    $("t-scale").textContent = `SCALE: ${first.scale_label || "1 HEX = 3 MILES (1 LEAGUE)"}`;
  }

  function chipSVG(kind) {
    const sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sv.setAttribute("width", 14); sv.setAttribute("height", 14); sv.setAttribute("viewBox", "-7 -7 14 14");
    PlateDraw.drawIcon(sv, kind, 0, 0, 0.85);
    return sv;
  }
  /* Terrain types that appear anywhere on the map, from the summary's defaults
   * plus whatever each loaded plate turns out to hold. */
  function buildLegend() {
    const legend = $("legend");
    legend.textContent = "";
    for (const key of Object.keys(registry.terrain)) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.innerHTML = `<i style="background:${registry.terrain[key].color}"></i>${esc(registry.terrain[key].label)}`;
      legend.appendChild(chip);
    }
    for (const key of Object.keys(registry.features || {})) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.appendChild(chipSVG(key));
      chip.appendChild(document.createTextNode(registry.features[key].label));
      legend.appendChild(chip);
    }
  }

  function showToast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => t.classList.remove("show"), 6000);
  }
})();
