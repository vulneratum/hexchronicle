/*
 * HexChronicle overview — the whole map as one picture, for zoom levels where
 * building every plate as SVG would stall the browser.
 *
 * Below OV_MAX the atlas builds no plates at all; instead this module paints
 * EVERY SUBHEX, in its own terrain colour, into one bitmap and draws that
 * bitmap under the map. Subhexes stay visible at every zoom (there is no
 * flat-dominant-colour hexagon here); only the per-hex detail — shorelines,
 * streams, icons, numbers — waits until you zoom in, where the shared atlas
 * (plate-draw.js) takes over exactly as before.
 *
 * Used by the published site (build/renderer.js) and the editor, so the two
 * cannot drift. Loaded by the Node build and server too, for overviewData().
 *
 * DATA SHAPE (docs/world/overview.json, GET /api/overview):
 *   { keys: [terrain keys], plates: [{ id, coord }], cells: [string per plate],
 *     rivers: [pi, k, pj, k2, …] }
 *   cells[i] is 157 characters, one per subhex in geometry order; character
 *   code 48 + n means keys[n], and "." means the position belongs to another
 *   plate (seam ownership) and is painted by that plate instead.
 */
(function (global) {
  "use strict";
  const G = (typeof HexGeo !== "undefined") ? HexGeo : require("./geometry.js");
  const OV_MAX = 0.12;            // atlas zoom below which the overview is shown

  /* ---------- data (Node: build.js and editor/server.js) ---------- */
  function overviewData(plateIds, coordOf, terrainOf, keys, riverPairs) {
    const geo = G.buildPlateHexes();
    const coords = {};
    for (const id of plateIds) coords[id] = coordOf(id);
    const own = G.plateOwnership(coords);
    const kIdx = new Map(keys.map((k, i) => [k, i]));
    const cells = plateIds.map(id => {
      let s = "";
      for (const h of geo) {
        if (own.isBorrowed(id, h.sub)) { s += "."; continue; }
        const i = kIdx.get(terrainOf(id, h.sub));
        s += String.fromCharCode(48 + (i == null ? 0 : i));
      }
      return s;
    });
    return { keys, plates: plateIds.map(id => ({ id, coord: coords[id] })), cells, rivers: riverPairs || [] };
  }

  /* ---------- drawing (browser) ---------- */
  function createOverview(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    let data = null, pic = null;
    const geo = G.buildPlateHexes();

    function setData(d) { data = d; pic = null; }
    function colorOf(key) { const t = (opts.registry && opts.registry.terrain || {})[key]; return t ? t.color : "#cccccc"; }

    function build() {
      const pts = data.plates.map(p => G.plateToPx(p.coord[0], p.coord[1]));
      const R = G.RL + G.SIZE;
      const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const p of pts) { b.minX = Math.min(b.minX, p.x - R); b.maxX = Math.max(b.maxX, p.x + R); b.minY = Math.min(b.minY, p.y - R); b.maxY = Math.max(b.maxY, p.y + R); }
      // ~3 px per subhex, capped so the bitmap stays inside every browser's canvas limit
      let k = 3 / (Math.sqrt(3) * G.SIZE);
      const maxPx = 9e6;
      if ((b.maxX - b.minX) * (b.maxY - b.minY) * k * k > maxPx) k = Math.sqrt(maxPx / ((b.maxX - b.minX) * (b.maxY - b.minY)));
      const PW = Math.max(1, Math.ceil((b.maxX - b.minX) * k)), PH = Math.max(1, Math.ceil((b.maxY - b.minY) * k));
      const c = document.createElement("canvas"); c.width = PW; c.height = PH;
      const g = c.getContext("2d");
      const img = g.createImageData(PW, PH), buf = new Uint32Array(img.data.buffer);
      // a small pixel hexagon, stamped once per subhex
      const rr = G.SIZE * k * 1.18, RR = Math.ceil(rr), stamp = [];
      for (let dy = -RR; dy <= RR; dy++) for (let dx = -RR; dx <= RR; dx++) {
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax <= Math.sqrt(3) / 2 * rr && ay <= rr - ax / Math.sqrt(3)) stamp.push(dx, dy);
      }
      if (!stamp.length) stamp.push(0, 0);
      const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
      const col = data.keys.map(key => {
        const h = colorOf(key), r = parseInt(h.slice(1, 3), 16), gg = parseInt(h.slice(3, 5), 16), bb = parseInt(h.slice(5, 7), 16);
        return le ? ((255 << 24) | (bb << 16) | (gg << 8) | r) >>> 0 : ((r << 24) | (gg << 16) | (bb << 8) | 255) >>> 0;
      });
      for (let pi = 0; pi < data.plates.length; pi++) {
        const P = pts[pi], s = data.cells[pi];
        for (let kk = 0; kk < geo.length; kk++) {
          const ch = s.charCodeAt(kk);
          if (ch === 46) continue;                          // "." — another plate paints it
          const cv = col[ch - 48];
          const x = Math.round((P.x + geo[kk].x - b.minX) * k), y = Math.round((P.y + geo[kk].y - b.minY) * k);
          for (let j = 0; j < stamp.length; j += 2) {
            const xx = x + stamp[j], yy = y + stamp[j + 1];
            if (xx < 0 || yy < 0 || xx >= PW || yy >= PH) continue;
            buf[yy * PW + xx] = cv;
          }
        }
      }
      g.putImageData(img, 0, 0);
      const rv = data.rivers || [];
      if (rv.length) {
        const style = (opts.registry && opts.registry.lines || {}).river || { color: "#7ea6c9" };
        g.strokeStyle = style.color; g.lineCap = "round"; g.lineWidth = Math.max(0.8, 1.6 * k / 0.07);
        g.beginPath();
        for (let i = 0; i < rv.length; i += 4) {
          const a = pts[rv[i]], h1 = geo[rv[i + 1]], c2 = pts[rv[i + 2]], h2 = geo[rv[i + 3]];
          if (!a || !c2 || !h1 || !h2) continue;
          g.moveTo((a.x + h1.x - b.minX) * k, (a.y + h1.y - b.minY) * k);
          g.lineTo((c2.x + h2.x - b.minX) * k, (c2.y + h2.y - b.minY) * k);
        }
        g.stroke();
      }
      return { c, k, ox: b.minX, oy: b.minY };
    }

    /* paint the picture for the current camera; `show` false clears it */
    function draw(tx, ty, s, show) {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const W = Math.round((r.width || global.innerWidth) * dpr), H = Math.round((r.height || global.innerHeight) * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!show || !data) return;
      if (!pic) pic = build();
      const sc = s / pic.k;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (tx + pic.ox * s), dpr * (ty + pic.oy * s));
      ctx.drawImage(pic.c, 0, 0);
    }

    return { setData, draw, invalidate: () => { pic = null; }, get data() { return data; } };
  }

  const Overview = { OV_MAX, overviewData, createOverview };
  if (typeof module !== "undefined" && module.exports) module.exports = Overview;
  else global.Overview = Overview;
})(typeof window !== "undefined" ? window : this);
