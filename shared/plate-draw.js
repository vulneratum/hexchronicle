/*
 * HexChronicle plate draw core — the shared rendering used by BOTH the
 * published site (build/renderer.js) and the local editor (editor/editor.js),
 * so the two can never drift (README §6: the editor shares the renderer).
 *
 * This module draws ONLY. It knows nothing about pan/zoom, taps, cards, or
 * painting — the site and editor each attach their own interaction to the
 * `world` group and layers this returns. Depends on HexGeo (shared/geometry.js).
 *
 *   PlateDraw.create(svg, model) -> controller
 *   PlateDraw.drawIcon(parent, type, cx, cy, scale)   // also used for legend chips
 *
 * model = {
 *   geo,           // HexGeo.buildPlateHexes()
 *   plate,         // { id, default_terrain, neighbors, ... }
 *   registry,      // { terrain:{key:{color,label}}, features:{key:{label}} }
 *   terrainByNum,  // { "001": "plains", ... } for all subhexes
 *   hexContent,    // { "104": { feature:{type,name} }, ... }
 *   lines,         // [ { type:"river"|"road", path:["023",...] } ]
 * }
 */
(function (global) {
  "use strict";
  const G = global.HexGeo || (typeof require !== "undefined" ? require("./geometry.js") : null);
  const SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* feature icon vocabulary — the single source for map icons and legend chips */
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

  function create(svg, model, opts) {
    opts = opts || {};
    const { SIZE, RL, hexCorners, plateCorners } = G;
    const T = model.registry.terrain, F = model.registry.features;
    const geo = model.geo;
    const bySub = new Map(geo.map(h => [h.sub, h]));

    const world = el("g", {}, svg);
    const layers = {
      fill:  el("g", {}, world),
      water: el("g", {}, world),
      road:  el("g", {}, world),
      icon:  el("g", {}, world),
      num:   el("g", { style: "transition:opacity .3s" }, world),
      frame: el("g", {}, world),
      sel:   el("g", {}, world),
    };

    /* terrain fills — keep a handle per subhex so a single hex can be recolored */
    const fillBySub = new Map();
    for (const h of geo) {
      const spec = T[model.terrainByNum[h.sub]] || { color: "#cccccc" };
      const poly = el("polygon", {
        points: hexCorners(h.x, h.y, SIZE),
        fill: spec.color, stroke: "rgba(0,0,0,0.16)", "stroke-width": 1
      }, layers.fill);
      fillBySub.set(h.sub, poly);
    }

    function setTerrain(sub, type) {
      const poly = fillBySub.get(sub);
      if (!poly) return;
      const spec = T[type] || { color: "#cccccc" };
      poly.setAttribute("fill", spec.color);
      model.terrainByNum[sub] = type;
    }

    /* line features */
    function rebuildLines(lines) {
      layers.water.textContent = "";
      layers.road.textContent = "";
      for (const ln of (lines || model.lines)) {
        const pts = ln.path.map(s => bySub.get(s)).filter(Boolean);
        if (pts.length < 2) continue;
        if (ln.type === "river") {
          el("path", { d: smoothPath(pts), fill: "none", stroke: "#7ea6c9", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.9 }, layers.water);
        } else {
          el("path", { d: smoothPath(pts), fill: "none", stroke: "#6b5138", "stroke-width": 2.4, "stroke-linecap": "round" }, layers.road);
        }
      }
    }
    rebuildLines(model.lines);

    /* feature icons + settlement name labels */
    function rebuildFeatures(hexContent) {
      const content = hexContent || model.hexContent;
      layers.icon.textContent = "";
      for (const h of geo) {
        const c = content[h.sub];
        if (!c || !c.feature) continue;
        drawIcon(layers.icon, c.feature.type, h.x, h.y, 1);
        if (c.feature.type === "city" || c.feature.type === "town") {
          const t = el("text", {
            x: h.x, y: h.y + 22, "text-anchor": "middle",
            "font-family": "'IM Fell English SC',serif",
            "font-size": c.feature.type === "city" ? 15 : 12, fill: "#2b2b23"
          }, layers.icon);
          t.textContent = c.feature.name || "";
        }
      }
    }
    rebuildFeatures(model.hexContent);

    /* subhex numbers */
    for (const h of geo) {
      const t = el("text", {
        x: h.x, y: h.y - SIZE * 0.42, "text-anchor": "middle",
        "font-family": "'IBM Plex Mono',monospace", "font-size": 8.5, fill: "rgba(43,43,35,0.6)"
      }, layers.num);
      t.textContent = h.num;
    }
    function setNumbersVisible(v) { layers.num.style.opacity = v ? 1 : 0; }

    /* plate frame + six neighbor chips (interaction attaches click handlers) */
    el("polygon", { points: plateCorners(RL + SIZE * 0.2), fill: "none", stroke: "#2e6f6a", "stroke-width": 4, "stroke-linejoin": "round" }, layers.frame);
    const neighborChips = [];
    const NEI = [
      { dir: "e", ang: 0 }, { dir: "se", ang: 60 }, { dir: "sw", ang: 120 },
      { dir: "w", ang: 180 }, { dir: "nw", ang: 240 }, { dir: "ne", ang: 300 }
    ];
    const neighbors = model.plate.neighbors || {};
    for (const n of NEI) {
      const a = Math.PI / 180 * n.ang, R = RL + SIZE * 1.35;
      const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
      const g = el("g", { transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`, style: "cursor:pointer" }, layers.frame);
      el("polygon", { points: hexCorners(0, 0, 20), fill: "#e9e2cf", stroke: "#2e6f6a", "stroke-width": 2.5 }, g);
      const t1 = el("text", { "text-anchor": "middle", y: -2, "font-size": 6.4, fill: "#2e6f6a", "font-family": "'IBM Plex Mono',monospace" }, g);
      t1.textContent = "36-MI HEX";
      const nid = neighbors[n.dir] || null;
      const t2 = el("text", { "text-anchor": "middle", y: 9, "font-size": 11, "font-weight": 700, fill: "#2e6f6a", "font-family": "'Alegreya Sans',sans-serif" }, g);
      t2.textContent = nid ? nid : "—";
      neighborChips.push({ dir: n.dir, nid, g });
    }

    return {
      world, layers, fillBySub, neighborChips,
      setTerrain, setNumbersVisible, rebuildLines, rebuildFeatures,
      hexBySub: bySub,
    };
  }

  const PlateDraw = { create, drawIcon, el };
  if (typeof module !== "undefined" && module.exports) module.exports = PlateDraw;
  else global.PlateDraw = PlateDraw;
})(typeof window !== "undefined" ? window : this);
