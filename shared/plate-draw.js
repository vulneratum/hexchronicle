/*
 * HexChronicle plate draw core — the shared rendering used by BOTH the
 * published site (build/renderer.js) and the local editor (editor/editor.js),
 * so the two can never drift (README §6: the editor shares the renderer).
 *
 * This module draws ONLY. It knows nothing about pan/zoom, taps, cards, or
 * painting — the site and editor each attach their own interaction to the
 * `world` group and layers this returns. Depends on HexGeo (shared/geometry.js).
 *
 *   PlateDraw.createAtlas(svg, opts) -> controller for the WHOLE map
 *   PlateDraw.drawIcon(parent, type, cx, cy, scale)   // also used for legend chips
 *
 * There is ONE renderer and one entry point. A second single-plate controller
 * used to live here for the published page; it is gone, because the site is now
 * the same atlas as the editor. Two renderers would drift, and drift in this
 * file means a hex belonging to one plate in the editor and a different plate on
 * the site — the map disagreeing with itself.
 *
 * opts = {
 *   registry,           // { terrain:{key:{color,label}}, features, lines }
 *   stateOf(id),        // a plate's interior, or null while it is loading
 *   request(id),        // "please load this one" — the caller does the fetching
 *   viewportRect(),     // the visible world rect, for culling
 *   linesOf(id, st),    // optional: which of a plate's lines to draw
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
    } else if (feature === "landmark") {
      // a tall, narrow black spire on a short base — lighthouses, wizards' towers,
      // pylons, tower dungeons. About the height of the city mark; the thin pale
      // edge keeps it readable on dark terrain (forest, taiga, mountains).
      el("path", { d: "M 0 -9 L 3.2 7.5 L -3.2 7.5 Z", fill: "#1c1a17", stroke: "#f0ead2", "stroke-width": 0.9, "stroke-linejoin": "round" }, g);
    } else if (feature === "lair") {
      el("rect", { x: -5.4, y: -5.4, width: 10.8, height: 10.8, fill: "#f0ead2", stroke: "#9e3d34", "stroke-width": 2, transform: "rotate(45)" }, g);
      const t = el("text", { "text-anchor": "middle", y: 3.4, "font-size": 9, "font-weight": 700, fill: "#9e3d34", "font-family": "'Alegreya Sans',sans-serif" }, g);
      t.textContent = "M";
    }
    return g;
  }

  /*
   * A line's path is a list of subhex addresses (README §2). A bare "023" means
   * this plate; "0003-023" names any plate — that is how a road, river or path
   * crosses a plate boundary while remaining ONE line feature in ONE file.
   *
   * Returns RUNS of points: maximal stretches of consecutive resolvable
   * addresses. An address on a plate we cannot place (not adjacent, not built)
   * ENDS the run rather than being skipped, so a partially-known path draws the
   * stretches it knows instead of a wrong straight line across the gap.
   *
   * Every point is the hex's CENTRE. A line starts, ends and joins on centres,
   * whatever the hex is painted — a river reaching a lake runs to the centre of
   * the lake hex like any other line.
   */
  function resolveRuns(path, bySub, offsetFor) {
    const runs = [];
    let run = [];
    for (const entry of (path || [])) {
      const a = G.parseAddr(entry);
      const h = a && bySub.get(a.sub);
      const off = a && (a.plate ? offsetFor(a.plate) : { x: 0, y: 0 });
      if (!h || !off) { if (run.length) runs.push(run); run = []; continue; }
      const x = h.x + off.x, y = h.y + off.y;
      // Position IS the identity. "023" and "0001-023" name the same hex, and a
      // hex reached from two different plates resolves to one point — so keying
      // on the resolved centre joins them without threading an owner id around.
      run.push({ x, y, plate: a.plate || null, key: x.toFixed(2) + "," + y.toFixed(2) });
    }
    if (run.length) runs.push(run);
    return runs;
  }

  /* ============================================================= *
   * Terrain — one plain hexagon per subhex
   *
   * Every subhex is drawn as its own straight-edged hexagon, filled with its own
   * terrain colour. No terrain type is special: water and ocean are hexagons
   * like everything else, with no blending into their neighbours and no
   * smoothed coastline. The registry's `water: true` flag still exists (the
   * editor's ocean fill reads it) but drawing does not look at it.
   *
   * Hexagons of the same terrain are merged into ONE <path> per type, plus one
   * path for the grid stroke, so a plate costs a handful of nodes rather than
   * one per subhex.
   * ============================================================= */

  const f1 = n => n.toFixed(2);
  const ringPath = pts => "M " + pts.map(p => f1(p[0]) + "," + f1(p[1])).join(" L ") + " Z";

  /* Per-hex geometry, computed once for a plate's frozen lattice: `full` is the
   * whole hexagon as a subpath string, used for the fill and the grid stroke. */
  function terrainMesh(geo) {
    const S = G.SIZE;
    const cells = geo.map(h => {
      const outer = [];
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 180 * (60 * k - 30);
        outer.push([h.x + S * Math.cos(a), h.y + S * Math.sin(a)]);
      }
      return { sub: h.sub, q: h.q, r: h.r, x: h.x, y: h.y, full: ringPath(outer) };
    });
    return { cells, byKey: new Map(cells.map(c => [c.q + "," + c.r, c])) };
  }

  /* Every owned hexagon grouped by its terrain type, plus the grid. */
  function meshSubpaths(mesh, terrainOf, owns) {
    const byType = new Map();
    const grid = [];
    for (const c of mesh.cells) {
      // ONE PHYSICAL HEX, ONE PAINTING. A plate's rim runs through subhex
      // centres, so 30 of its positions are also positions on a neighbour. Only
      // the OWNER fills and strokes them; a plate that merely borrows a position
      // skips it entirely, or every seam would carry two stacked fills and a
      // double-weight grid line. Nothing is left unpainted: those positions sit
      // exactly RL from the owner's centre, so whenever one is on screen the
      // owner is inside the cull margin and has been built.
      if (owns && !owns(c.sub)) continue;
      grid.push(c.full);
      const type = terrainOf(c.sub);
      let a = byType.get(type);
      if (!a) byType.set(type, a = []);
      a.push(c.full);
    }
    return { byType, grid: grid.join(" ") };
  }

  /*
   * The terrain stack:
   *   a. fills — one <path> per terrain type, in first-seen order
   *   b. grid  — the lattice stroke, one <path>
   *
   * `opts.gridInto` sends the grid to a different element, so the caller can
   * slip a layer between the fills and the grid — the atlas puts rivers there.
   * `opts.owns` limits both to the positions this plate owns.
   */
  function renderTerrainInto(parent, mesh, terrainOf, colorOf, opts) {
    opts = opts || {};
    const { byType, grid } = meshSubpaths(mesh, terrainOf, opts.owns);
    for (const [type, ds] of byType) {
      el("path", { d: ds.join(" "), fill: colorOf(type), stroke: "none" }, parent);
    }
    el("path", {
      d: grid, fill: "none",
      stroke: opts.gridStroke || "rgba(0,0,0,0.16)", "stroke-width": opts.gridWidth || 1,
    }, opts.gridInto || parent);
  }

  /*
   * A chain of hexes -> a curve that passes through the EDGE MIDPOINTS and bends
   * around the interior hexes, starting and ending exactly on the first and last
   * hex centre.
   *
   * That is the right shape for a RUN, whose interior vertices are all
   * pass-throughs and whose ends are junctions or termini. It was only ever
   * wrong when applied to a whole line, because a line may run straight through
   * a hex where something else joins — and there the curve bends around the
   * centre instead of touching it, so the two lines never met.
   */
  function smoothPath(pts) {
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const c = pts[i];
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const L = pts[pts.length - 1];
    d += ` L ${L.x.toFixed(1)} ${L.y.toFixed(1)}`;
    return d;
  }

  /* ============================================================= *
   * Line features as a NETWORK, not a list of lines
   *
   * Rivers and streams that meet merge into one waterway; paths, roads and
   * paved roads that meet join. Two things make that work:
   *
   *  - ONE GRAPH PER CATEGORY. Every line contributes undirected edges between
   *    consecutive hexes, and an edge shared by several lines is kept once at
   *    the heaviest grade using it. Three rivers down one valley used to stroke
   *    the shared tail three times, which — with water at 0.9 opacity — made it
   *    darker and fatter than the branches feeding it, the visual opposite of a
   *    merge.
   *
   *  - RUNS, not lines, are the drawing unit. A run is a maximal chain of
   *    same-grade edges whose interior vertices all have degree 2, and it
   *    terminates at the CENTRE of the junction or terminus at either end. So
   *    every branch of a junction ends on the same point and they genuinely
   *    touch; pass-through hexes keep the old smooth bend. A run is one <path>,
   *    which also keeps a dashed grade's pattern continuous along its length
   *    instead of restarting it at every hex.
   *
   * Water and road are SEPARATE graphs, so a road crossing a river shares no
   * vertex: no merge, no cap, and the layer order draws the road over the water
   * like a bridge.
   * ============================================================= */

  // Water is drawn slightly transparent. It goes on the category's GROUP, not on
  // each path: group opacity flattens first, so strokes that overlap inside a
  // run — or where two runs meet at a junction — never double-darken.
  const CATEGORY_OPACITY = { water: 0.9 };
  const CATEGORY_ORDER = ["water", "road"];      // water beneath road

  const edgeKey = (a, b) => (a < b ? a + " " + b : b + " " + a);

  /* Extend a trail from `to`, away from `from`, through degree-2 vertices that
   * continue the same grade. Consumes the edges it walks. */
  function extendRun(g, from, to, type, seen) {
    const chain = [from, to];
    let prev = from, cur = to;
    for (;;) {
      const nb = g.adj.get(cur);
      if (!nb || nb.size !== 2) break;                    // junction or terminus: stop
      let next = null;
      for (const n of nb) if (n !== prev) next = n;
      if (next == null) break;
      const k = edgeKey(cur, next);
      if (seen.has(k) || g.edge.get(k) !== type) break;   // already drawn, or the grade changes
      seen.add(k);
      chain.push(next);
      prev = cur; cur = next;
    }
    return chain;
  }

  function buildCategoryGraphs(lines, bySub, offsetFor, styleOf) {
    const graphs = new Map();
    for (const ln of (lines || [])) {
      const st = styleOf(ln.type);
      const cat = st.category || "road";
      let g = graphs.get(cat);
      if (!g) graphs.set(cat, g = { pos: new Map(), adj: new Map(), edge: new Map() });
      for (const run of resolveRuns(ln.path, bySub, offsetFor)) {
        for (let i = 0; i < run.length; i++) {
          const n = run[i];
          g.pos.set(n.key, n);
          if (!g.adj.has(n.key)) g.adj.set(n.key, new Set());
          if (i === 0) continue;
          const a = run[i - 1].key, b = n.key;
          if (a === b) continue;                          // a repeated hex is not an edge
          g.adj.get(a).add(b);
          g.adj.get(b).add(a);
          const k = edgeKey(a, b);
          const cur = g.edge.get(k);
          // heaviest grade wins: paved > road > path, river > stream
          if (!cur || st.width > styleOf(cur).width) g.edge.set(k, ln.type);
        }
      }
    }
    return graphs;
  }

  /*
   * Draw `lines` as one network per category into whatever the caller nominates.
   * ctx = {
   *   bySub, offsetFor, styleOf,
   *   layerFor(category, plateId) -> parent element | null,
   *   localOrigin(plateId) -> {x,y}          // optional
   * }
   *
   * ONE GRAPH MAY SPAN PLATES. The site draws a single plate and takes the
   * simple path: layerFor ignores the plate and nothing is shifted. The editor
   * builds one graph across the whole atlas — which is what makes a road on one
   * plate junction with a road on its neighbour at a shared seam hex — and hands
   * back a different layer per plate, so each run is culled and torn down with
   * the plate that draws it. `localOrigin` is then subtracted so the run lands
   * correctly inside that already-positioned layer.
   *
   * A run is drawn by the first plate along it that HAS a layer, so a run
   * reaching in from an off-screen plate is still drawn rather than dropped.
   */
  function drawLineNetwork(lines, ctx) {
    const { bySub, offsetFor, styleOf, layerFor, localOrigin } = ctx;
    const graphs = buildCategoryGraphs(lines, bySub, offsetFor, styleOf);

    const cats = [...graphs.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? CATEGORY_ORDER.length : ia) - (ib < 0 ? CATEGORY_ORDER.length : ib);
    });

    for (const cat of cats) {
      const g = graphs.get(cat);
      // one <g> per (category, plate), so category opacity still flattens
      const boxes = new Map();
      const boxFor = plate => {
        const k = String(plate);
        if (!boxes.has(k)) {
          const parent = layerFor(cat, plate);
          boxes.set(k, parent ? el("g", CATEGORY_OPACITY[cat] ? { opacity: CATEGORY_OPACITY[cat] } : {}, parent) : null);
        }
        return boxes.get(k);
      };
      /* the first node along `keys` whose plate has somewhere to draw */
      const placement = keys => {
        for (const key of keys) {
          const plate = g.pos.get(key).plate;
          const box = boxFor(plate);
          if (box) return { box, shift: (localOrigin && localOrigin(plate)) || { x: 0, y: 0 } };
        }
        return null;
      };

      // every edge exactly once, grown into the longest run it belongs to
      const seen = new Set();
      for (const [k, type] of g.edge) {
        if (seen.has(k)) continue;
        seen.add(k);
        const i = k.indexOf(" ");
        const a = k.slice(0, i), b = k.slice(i + 1);
        const fwd = extendRun(g, a, b, type, seen);       // [a, b, …]
        const back = extendRun(g, b, a, type, seen);      // [b, a, …] the other way
        const chain = back.slice(2).reverse().concat(fwd);

        const place = placement(chain);
        if (!place) continue;
        const { x: sx, y: sy } = place.shift;
        const pts = chain.map(key => {
          const p = g.pos.get(key);
          return { x: p.x - sx, y: p.y - sy };
        });

        const st = styleOf(type);
        const attrs = {
          d: smoothPath(pts),
          fill: "none", stroke: st.color, "stroke-width": st.width,
          "stroke-linecap": "round", "stroke-linejoin": "round",
        };
        if (st.dash) attrs["stroke-dasharray"] = st.dash;
        el("path", attrs, place.box);
      }

      /*
       * A junction gets a filled round cap on the hex CENTRE, sized to the
       * heaviest grade meeting there, so the join reads as solid water or a
       * solid fork rather than as separate strokes abutting. Branches keep
       * their own widths, so a stream visibly feeds into a river.
       *
       * A degree-2 vertex where the GRADE changes gets one too — it is where a
       * stream becomes a river, and the cap hides the width step.
       */
      for (const [key, nb] of g.adj) {
        if (!nb.size) continue;
        let heaviest = null, mixed = false;
        for (const n of nb) {
          const type = g.edge.get(edgeKey(key, n));
          if (!type) continue;
          if (heaviest == null) heaviest = type;
          else if (type !== heaviest) {
            mixed = true;
            if (styleOf(type).width > styleOf(heaviest).width) heaviest = type;
          }
        }
        if (heaviest == null || (nb.size < 3 && !mixed)) continue;
        const place = placement([key]);
        if (!place) continue;
        const st = styleOf(heaviest), p = g.pos.get(key);
        el("circle", {
          cx: (p.x - place.shift.x).toFixed(1), cy: (p.y - place.shift.y).toFixed(1),
          r: (st.width / 2).toFixed(2), fill: st.color,
        }, place.box);
      }
    }
  }

  /* ============================================================= *
   * THE PLATE LATTICE — one line per seam, not one frame per plate
   *
   * Three separate faults produced the doubled boundaries, and each needed its
   * own fix. Measured, not guessed:
   *
   * 1. THE RADIUS WAS WRONG. The frame was stroked at RL + SIZE*0.2 = 317.20,
   *    but adjacent plate centres are SQ3*RL = 540.40 apart and a hexagon of
   *    radius 317.20 needs 549.41 to tile. Every pair of neighbours overlapped
   *    by 9.01px before stroke width even counted. The radius is now exactly
   *    RL, so adjacent frames share their seam exactly.
   *
   * 2. EACH SEAM WAS STROKED TWICE. Even at the right radius, both plates drew
   *    their shared edge, so interior seams came out at double weight against a
   *    single-weight outer border. So the lattice is not a frame per plate at
   *    all: every plate's six edges go into one set, an edge claimed by two
   *    plates is kept ONCE, and the whole thing is stroked as a single path.
   *    Interior and outer edges then render identically, and the entire map
   *    boundary costs ONE node.
   *
   * 3. THE FRAME CANNOT CONTAIN THE SUBHEXES, and no radius will fix that. The
   *    furthest subhex CORNER is 338.00 from the plate centre — RL + 26.00 —
   *    because a hexagonal plate boundary and a hexagonal subhex footprint are
   *    not the same shape, and buildPlateHexes() is frozen (README §2).
   *
   *    THE CHOICE, made deliberately: the boundary stays an IDEALISED hexagon
   *    at RL, drawn ABOVE the terrain, and subhexes are allowed to straddle it.
   *    That is what the line means — "this is the 36-mile hex" — and it stays a
   *    clean, legible hexagon at every zoom. The alternative, tracing the union
   *    outline of the subhexes each plate actually owns, would be truthful to
   *    the data but would replace the hexagon with a jagged 30-odd segment path
   *    that reads as noise. Which subhex belongs to which plate is answered
   *    exactly, and visibly, by the seam-ownership rule and the addresses
   *    printed on the hexes — not by this line.
   * ============================================================= */

  /*
   * Every edge of every plate hexagon, each kept once. `plates` is a list of
   * { x, y } centres in world coordinates. Endpoints are rounded before keying
   * so that the same corner arrived at from two different plate centres is
   * recognised as one point rather than two a float apart.
   */
  function plateBoundaryEdges(plates) {
    const key = p => Math.round(p[0] * 100) + "," + Math.round(p[1] * 100);
    const seen = new Map();
    for (const e of (plates || [])) {
      const corners = [];
      for (let k = 0; k < 6; k++) {
        const ang = Math.PI / 180 * (60 * k + 30);        // plateCorners' own angles
        corners.push([e.x + G.RL * Math.cos(ang), e.y + G.RL * Math.sin(ang)]);
      }
      for (let k = 0; k < 6; k++) {
        const a = corners[k], b = corners[(k + 1) % 6];
        const ka = key(a), kb = key(b);
        const ek = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        const rec = seen.get(ek);
        if (rec) rec.count++;
        else seen.set(ek, { a, b, count: 1 });
      }
    }
    return [...seen.values()];
  }
  /* the whole map's boundary as ONE path: 6n edges less one per shared seam */
  const plateBoundaryPath = plates => plateBoundaryEdges(plates)
    .map(e => `M ${f1(e.a[0])} ${f1(e.a[1])} L ${f1(e.b[0])} ${f1(e.b[1])}`).join(" ");

  /* ============================================================= *
   * THE ATLAS — every plate on one canvas
   *
   * There is no "current plate". Plates are not a mode you enter; they are just
   * where a subhex happens to live. So this draws the whole map at once, culls
   * to the viewport, and answers "which subhex is under this point" — and both
   * the editor and the published site are built on it, which is the only way the
   * two can be guaranteed to look the same.
   *
   * LAYER ORDER is global, not per plate, and it is load-bearing:
   *
   *   under   every plate's terrain fills — one plain hexagon per subhex
   *   water   rivers and streams
   *   grid    the subhex grid stroke, over the rivers so it stays visible
   *   road    paths, roads, paved       ── over the rivers, so a crossing
   *   content icons, settlement names,     reads as a bridge
   *           subhex numbers — all PER HEX and all at the hex CENTRE
   *   frame   the plate lattice: ONE path for the whole map, above the terrain
   *           it crosses, so the line is clean and unbroken (see THE PLATE
   *           LATTICE above for why it is drawn there and at that radius). This
   *           line is the ONLY thing on the map that says where a 36-mile hex
   *           begins and ends — there is no plate label of any kind.
   *   ui      empty, for whatever the CALLER draws on top
   *
   * `ui` is the one layer this module never puts anything in. It is where a
   * caller's own overlay goes — the site's selected-hex outline, the editor's
   * selection, its in-progress line, its empty-position markers. This module
   * knows about none of those: it draws the MAP. Anything that exists only
   * because you can edit the world is the editor's to draw, in the editor's own
   * code, so it cannot leak onto the published site by accident.
   *
   * Because the layers are global rather than per plate, a river crossing a
   * boundary is never painted over by the neighbour's terrain, and the LINE
   * NETWORK can be one graph across the whole atlas — which is what lets two
   * plates' roads junction at a shared seam hex.
   *
   * The caller supplies the data through `stateOf(id)` (null while a plate is
   * still loading) and is told what to fetch through `request(id)`. Nothing here
   * knows about HTTP, files, or editing.
   * ============================================================= */

  const ATLAS_DEFAULTS = {
    gridStroke: "rgba(0,0,0,0.16)",
    cullMargin: G.RL * 0.6,          // build a little beyond the viewport so panning does not pop
    iconLo: 0.16, iconHi: 0.42,      // zoom band over which icons and names fade in
    numLo: 0.75, numHi: 1.05,        // zoom band over which subhex numbers fade in
  };

  function createAtlas(svg, opts) {
    opts = Object.assign({}, ATLAS_DEFAULTS, opts);
    const geo = opts.geo || G.buildPlateHexes();
    const bySub = new Map(geo.map(h => [h.sub, h]));
    const byKey = new Map(geo.map(h => [h.q + "," + h.r, h]));
    const mesh = terrainMesh(geo);
    const registry = opts.registry || {};
    const T = registry.terrain || {}, LN = registry.lines || {};
    const stateOf = opts.stateOf || (() => null);
    const request = opts.request || (() => {});
    const colorOf = type => (T[type] || { color: "#cccccc" }).color;
    function lineStyle(type) {
      const spec = LN[type];
      if (spec) return spec;
      return type === "river" || type === "stream"
        ? { category: "water", color: "#7ea6c9", width: type === "stream" ? 2 : 3 }
        : { category: "road", color: "#6b5138", width: 2.4 };
    }

    const world = el("g", {}, svg);
    const layers = {
      under:   el("g", {}, world),
      water:   el("g", {}, world),
      grid:    el("g", {}, world),
      road:    el("g", {}, world),
      content: el("g", {}, world),
      frame:   el("g", {}, world),
      ui:      el("g", {}, world),
    };

    let plates = [];                       // [{ id, name, coord, x, y, … }]
    let own = G.plateOwnership({});
    const recs = new Map();                // id -> render record
    let view = { tx: 0, ty: 0, s: 1 };

    const posOf = id => { const e = plates.find(p => p.id === id); return e ? { x: e.x, y: e.y } : null; };
    const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
    const iconOpacity = () => clamp01((view.s - opts.iconLo) / (opts.iconHi - opts.iconLo));
    const numOpacity = () => clamp01((view.s - opts.numLo) / (opts.numHi - opts.numLo));

    /*
     * The lattice is anchored on the LOWEST plate id at (0,0) and never moves
     * again. Nothing re-origins, so a world coordinate means the same thing for
     * the whole session — and seam ownership, which is derived from relative
     * position, is unaffected by the choice either way.
     */
    function setPlates(list) {
      const coords = {};
      for (const p of list) coords[p.id] = p.coord;
      own = G.plateOwnership(coords);
      plates = list.map(p => {
        const o = G.plateToPx(p.coord[0], p.coord[1]);
        return Object.assign({}, p, { x: o.x, y: o.y });
      });
      drawBoundary();
      // positions are absolute, so anything already built is thrown away and
      // the viewport pass rebuilds only what is actually on screen
      for (const id of [...recs.keys()]) drop(id);
      update();
    }

    /* The whole map's boundary, once. Not culled and not per plate: it is a
     * single path of a few dozen segments however large the atlas grows. */
    function drawBoundary() {
      layers.frame.textContent = "";
      const d = plateBoundaryPath(plates);
      if (!d) return;
      el("path", {
        d, fill: "none",
        stroke: opts.frameStroke || "#3f5c56",
        "stroke-width": opts.frameWidth || 3,
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }, layers.frame);
    }

    /* ---------- per-plate records ---------- */
    function createRec(e) {
      const at = { transform: `translate(${e.x.toFixed(1)} ${e.y.toFixed(1)})` };
      const rec = {
        id: e.id, entry: e,
        gUnder: el("g", at, layers.under),
        gGrid:  el("g", at, layers.grid),
        gWater: el("g", at, layers.water),      // this plate's share of the water network
        gRoad:  el("g", at, layers.road),       // …and of the road network
        gContent: el("g", at, layers.content),
        built: false, numsBuilt: false,
      };
      rec.gIcons = el("g", {}, rec.gContent);
      rec.gNum = el("g", {}, rec.gContent);
      // NO PLATE-LEVEL TEXT AT ALL. Not the name, not the title, not the id.
      // A 36-mile hex is shown by its BOUNDARY LINE and by nothing else; what
      // the map writes is per-hex — the subhex address, and a settlement's own
      // name. `id`, `name` and `title` remain real fields: they are in
      // plates/*.yaml, compiled into the atlas payload, and edited in the
      // editor's plate panel. They are simply not map labels.
      //
      // There is no flag for this and there is not meant to be one — no label
      // element is created, so there is nothing to hide, fade or misconfigure.
      // Nor is there a <title>: an SVG tooltip is plate text that appears on
      // hover, which is the same thing again.
      //
      // NO per-plate frame here either: the boundary is one path for the whole
      // map (drawBoundary), because a frame per plate strokes every interior
      // seam twice.
      recs.set(e.id, rec);
      return rec;
    }
    function drop(id) {
      const rec = recs.get(id);
      if (!rec) return;
      for (const g of [rec.gUnder, rec.gGrid, rec.gWater, rec.gRoad, rec.gContent]) g.remove();
      recs.delete(id);
    }

    function paint(rec, st) {
      rec.gUnder.textContent = "";
      rec.gGrid.textContent = "";
      renderTerrainInto(rec.gUnder, mesh, s => st.terrain[s] || st.defaultTerrain, colorOf, {
        gridStroke: opts.gridStroke, gridInto: rec.gGrid,
        // a borrowed seam position is the OWNER's to paint, and only theirs
        owns: sub => !own.isBorrowed(rec.id, sub),
      });
      rec.built = true;
      drawIcons(rec, st);
      if (rec.numsBuilt) drawNumbers(rec);
    }

    function drawIcons(rec, st) {
      rec.gIcons.textContent = "";
      // every icon and its label sit at the hex centre, whatever the terrain
      for (const h of geo) {
        const c = (st.hexes || {})[h.sub];
        if (!c || !c.feature) continue;
        const a = h;
        drawIcon(rec.gIcons, c.feature.type, a.x, a.y, 1);
        if (c.feature.type === "city" || c.feature.type === "town" || c.feature.type === "landmark") {
          const t = el("text", {
            x: a.x, y: a.y + 22, "text-anchor": "middle",
            "font-family": "'IM Fell English SC',serif",
            "font-size": c.feature.type === "city" ? 15 : c.feature.type === "landmark" ? 11 : 12, fill: "#2b2b23",
          }, rec.gIcons);
          t.textContent = c.feature.name || "";
        }
      }
    }

    /* the FULL address, and on a seam position that is the owner's — the two
     * plates meeting there print one address, not two names for one hex */
    function drawNumbers(rec) {
      rec.gNum.textContent = "";
      for (const h of geo) {
        const t = el("text", {
          x: h.x, y: h.y - G.SIZE * 0.42, "text-anchor": "middle",
          "font-family": "'IBM Plex Mono',monospace", "font-size": 6.5, fill: "rgba(30,30,24,0.85)",
        }, rec.gNum);
        t.textContent = own.addressOf(rec.id, h.sub);
      }
      rec.numsBuilt = true;
    }

    /* ---------- the atlas-wide line network ---------- */
    /* Path entries are canonicalised to their OWNER's address, so a line on one
     * plate and a line on its neighbour that meet at a shared seam hex are one
     * node in one graph and junction properly. */
    function canonPath(path, lineOwnerId) {
      const out = [];
      for (const e of (path || [])) {
        const a = G.parseAddr(e);
        if (!a) continue;
        const o = own.ownerOf(a.plate || lineOwnerId, a.sub);
        out.push(o.plateId + "-" + o.sub);
      }
      return out;
    }
    function renderLines() {
      for (const rec of recs.values()) { rec.gWater.textContent = ""; rec.gRoad.textContent = ""; }
      if (!plates.length) return;
      const lines = [];
      for (const rec of recs.values()) {
        const st = stateOf(rec.id);
        if (!st) continue;
        const src = opts.linesOf ? opts.linesOf(rec.id, st) : (st.lines || []);
        for (const ln of src) lines.push({ type: ln.type, path: canonPath(ln.path, rec.id) });
      }
      drawLineNetwork(lines, {
        bySub, styleOf: lineStyle,
        offsetFor: posOf,        // build the graph in absolute world coordinates…
        localOrigin: posOf,      // …and hand each run back to its plate's own space
        layerFor: (cat, plate) => {
          const rec = recs.get(plate);
          if (!rec || !rec.built) return null;
          return cat === "water" ? rec.gWater : rec.gRoad;
        },
      });
    }

    /* ---------- viewport culling ---------- */
    function viewportRect() {
      if (opts.viewportRect) return opts.viewportRect();
      const r = svg.getBoundingClientRect();
      const w = r.width || 800, h = r.height || 600;
      return {
        xmin: (0 - view.tx) / view.s, xmax: (w - view.tx) / view.s,
        ymin: (0 - view.ty) / view.s, ymax: (h - view.ty) / view.s,
      };
    }
    const inView = (e, vp) =>
      e.x + G.RL + opts.cullMargin > vp.xmin && e.x - G.RL - opts.cullMargin < vp.xmax &&
      e.y + G.RL + opts.cullMargin > vp.ymin && e.y - G.RL - opts.cullMargin < vp.ymax;

    /*
     * Decide what is on screen, build the deltas, tear down what left. An
     * off-screen plate is never built and its interior is never fetched, so the
     * node count stays bounded however large the map grows — that, not level of
     * detail, is the budget. It matters most on the published site, where a
     * visitor may have the whole continent in front of them.
     */
    function update() {
      const vp = viewportRect();
      const vis = plates.filter(e => inView(e, vp));
      const want = new Set(vis.map(e => e.id));
      for (const id of [...recs.keys()]) if (!want.has(id)) drop(id);
      for (const e of vis) {
        let rec = recs.get(e.id) || createRec(e);
        const st = stateOf(e.id);
        if (!st) { request(e.id); continue; }        // frame only until it lands
        if (!rec.built) paint(rec, st);
      }

      // 157 text nodes a plate: only worth existing inside the zoom band where
      // they can actually be read
      const showNums = numOpacity() > 0.01;
      for (const rec of recs.values()) {
        if (showNums && !rec.numsBuilt && rec.built) drawNumbers(rec);
        else if (!showNums && rec.numsBuilt) { rec.gNum.textContent = ""; rec.numsBuilt = false; }
      }
      renderLines();
      applyFade();
    }

    /* Only the content layer responds to zoom — terrain is drawn at full detail
     * at every scale, because that is what makes the map one continuous surface
     * rather than a set of tiles. */
    function applyFade() {
      layers.content.style.opacity = iconOpacity();
      for (const rec of recs.values()) rec.gNum.style.opacity = numOpacity();
    }

    /* ---------- hit testing ---------- */
    const plateAt = (wx, wy) => plates.find(e => G.insidePlate(wx - e.x, wy - e.y, G.RL)) || null;
    /*
     * A world point -> { plateId, sub }, resolved to the hex's OWNER.
     *
     * A seam position is contained by two plates (three at a corner) and which
     * one plateAt happens to find first is an accident of list order, so that
     * accident is settled HERE, once, for everything downstream: painting,
     * selection, metadata and line drawing all get the same answer.
     */
    function hexAt(wx, wy) {
      const e = plateAt(wx, wy);
      if (!e) return null;
      const a = G.pxToAxial(wx - e.x, wy - e.y);
      const h = byKey.get(a.q + "," + a.r);
      return h ? own.ownerOf(e.id, h.sub) : null;
    }
    /* the centre of a subhex in absolute world coordinates */
    function worldOf(plateId, sub) {
      const p = posOf(plateId), h = bySub.get(sub);
      return (p && h) ? { x: p.x + h.x, y: p.y + h.y } : null;
    }

    function setView(tx, ty, s) {
      view = { tx, ty, s };
      world.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
      applyFade();
    }
    /* the bounding box of every plate position, for framing the whole map */
    function bounds() {
      const pts = plates.length ? plates : [{ x: 0, y: 0 }];
      return {
        minX: Math.min(...pts.map(p => p.x)) - G.RL - G.SIZE,
        maxX: Math.max(...pts.map(p => p.x)) + G.RL + G.SIZE,
        minY: Math.min(...pts.map(p => p.y)) - G.RL - G.SIZE,
        maxY: Math.max(...pts.map(p => p.y)) + G.RL + G.SIZE,
      };
    }

    /* one subhex changed colour on one plate: repaint the plates that SHOW it */
    function invalidate(id) {
      const rec = recs.get(id);
      if (rec) rec.built = false;
    }
    function refresh() {
      for (const rec of recs.values()) {
        const st = stateOf(rec.id);
        if (st && !rec.built) paint(rec, st);
      }
      renderLines();
      applyFade();
    }

    return {
      world, layers, geo, bySub, byKey, mesh, recs,
      setPlates, setView, update, refresh, invalidate, renderLines, applyFade,
      hexAt, plateAt, worldOf, bounds, posOf, lineStyle, colorOf,
      get own() { return own; },
      get plates() { return plates; },
      iconOpacity, numOpacity,
    };
  }

  const PlateDraw = {
    createAtlas, drawIcon, el, resolveRuns, smoothPath, drawLineNetwork,
    terrainMesh, meshSubpaths, renderTerrainInto,
    plateBoundaryEdges, plateBoundaryPath,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = PlateDraw;
  else global.PlateDraw = PlateDraw;
})(typeof window !== "undefined" ? window : this);
