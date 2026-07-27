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
   * Each point carries BOTH the hex's true centre (x, y) and its anchor (ax, ay).
   * Edge midpoints are computed from the centres so neighbouring hexes agree on
   * their shared boundary point; only the in-hex routing follows the anchor.
   * `anchorFor(sub, plate)` may return null — a hex on another plate has no
   * anchor here, because this plate does not know that plate's terrain.
   */
  function resolveRuns(path, bySub, offsetFor, anchorFor) {
    const runs = [];
    let run = [];
    for (const entry of (path || [])) {
      const a = G.parseAddr(entry);
      const h = a && bySub.get(a.sub);
      const off = a && (a.plate ? offsetFor(a.plate) : { x: 0, y: 0 });
      if (!h || !off) { if (run.length) runs.push(run); run = []; continue; }
      const x = h.x + off.x, y = h.y + off.y;
      const an = anchorFor ? anchorFor(a.sub, a.plate) : null;
      // Position IS the identity. "023" and "0001-023" name the same hex, and a
      // hex reached from two different plates resolves to one point — so keying
      // on the resolved centre joins them without threading an owner id around.
      run.push({
        x, y, plate: a.plate || null,
        ax: an ? an.x + off.x : x, ay: an ? an.y + off.y : y,
        key: x.toFixed(2) + "," + y.toFixed(2),
      });
    }
    if (run.length) runs.push(run);
    return runs;
  }

  /* ============================================================= *
   * Terrain mesh — smooth shorelines
   *
   * A coastline drawn on hex boundaries is a zigzag; drawn as per-hex sectors
   * it is a many-sided polygon with a visible angle at every sector boundary.
   * Neither reads as a shore. So the water is treated as ONE REGION:
   *
   *   1. Build the water area per hex as before — a small central core plus the
   *      sectors facing water — but collect the EDGES of those sub-shapes
   *      instead of drawing them.
   *   2. An edge shared by two water sub-shapes appears twice and is interior;
   *      an edge appearing once is on the boundary. Chain the survivors into
   *      closed rings.
   *   3. Smooth each ring with Chaikin corner-cutting and fill them all as one
   *      path with fill-rule evenodd, so an enclosed island punches a hole.
   *
   * Smoothing moves the water edge off the sector boundaries, so the land can
   * no longer be drawn to meet it. Instead the land is drawn COMPLETE beneath
   * and the water is painted over the top — there is then no seam to misalign,
   * however far the smoothing moves the edge.
   *
   * Only the literal `water` key does this. Land — swamp included — is a plain
   * hexagon, and nothing bleeds outward into it.
   *
   * All of it is deterministic: same terrain data, same coastline, every render,
   * in both the editor and the published site.
   * ============================================================= */
  const WATER = "water";
  const CORE_R = 0.45;          // water core, as a fraction of the subhex circumradius
  const SHORE_PASSES = 2;       // Chaikin iterations: 2 is a natural shore, 3 very soft
  const EPS = 1e3;              // edge keys are rounded to 1/EPS so float noise cannot
                                // split one shared edge into two distinct ones

  /*
   * Which axial neighbour each sector faces. hexCorners() places corner k at
   * (60k - 30) degrees, so sector k — spanning corner k to corner k+1 — faces
   * outward along 60k degrees. DERIVED from the geometry rather than written
   * down: HexGeo.neighborDirs is in a different order, and an off-by-one here
   * puts the coastline on the wrong side of every hex while still looking
   * entirely plausible.
   */
  function sectorDirs() {
    const dirs = [];
    for (let k = 0; k < 6; k++) {
      const a0 = Math.PI / 180 * (60 * k - 30), a1 = Math.PI / 180 * (60 * (k + 1) - 30);
      const mx = (Math.cos(a0) + Math.cos(a1)) / 2, my = (Math.sin(a0) + Math.sin(a1)) / 2;
      let best = null, bestDot = -Infinity;
      for (const d of G.neighborDirs) {
        const p = G.axialToPx(d[0], d[1]);
        const len = Math.hypot(p.x, p.y) || 1;
        const dot = (p.x / len) * mx + (p.y / len) * my;
        if (dot > bestDot) { bestDot = dot; best = d; }
      }
      dirs.push(best);
    }
    return dirs;
  }

  const f1 = n => n.toFixed(2);

  const ringPath = pts => "M " + pts.map(p => f1(p[0]) + "," + f1(p[1])).join(" L ") + " Z";

  /*
   * Per-hex geometry, computed once for a plate's frozen lattice. Numeric point
   * arrays (`outer`, `inner`) as well as ready-made subpath strings, because the
   * boundary walk needs coordinates and the fills need strings.
   *
   *   full      the whole hexagon           (land fill, and the grid stroke)
   *   core      the small central hexagon
   *   sector[k] the ring piece facing neighbour k — the hexagon MINUS the core
   */
  function terrainMesh(geo) {
    const dirs = sectorDirs();
    const S = G.SIZE;
    const cells = geo.map(h => {
      const outer = [], inner = [];
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 180 * (60 * k - 30);
        const cos = Math.cos(a), sin = Math.sin(a);
        outer.push([h.x + S * cos, h.y + S * sin]);
        inner.push([h.x + S * CORE_R * cos, h.y + S * CORE_R * sin]);
      }
      const sectors = [], sectorPts = [];
      for (let k = 0; k < 6; k++) {
        const j = (k + 1) % 6;
        const quad = [inner[k], outer[k], outer[j], inner[j]];
        sectorPts.push(quad);
        sectors.push(ringPath(quad));
      }
      return {
        sub: h.sub, q: h.q, r: h.r, x: h.x, y: h.y, outer, inner, sectorPts,
        full: ringPath(outer), core: ringPath(inner), sectors,
      };
    });
    return { cells, dirs, byKey: new Map(cells.map(c => [c.q + "," + c.r, c])) };
  }

  /* the neighbour cell across sector k, or null at the plate rim */
  function neighbourOf(mesh, c, k) {
    const d = mesh.dirs[k];
    return mesh.byKey.get((c.q + d[0]) + "," + (c.r + d[1])) || null;
  }
  /* is the water region extended across sector k? off-plate counts as water so
   * the plate rim keeps a hard edge rather than dissolving into the background */
  function waterAcross(mesh, c, k, terrainOf) {
    const n = neighbourOf(mesh, c, k);
    return !n || terrainOf(n.sub) === WATER;
  }

  /*
   * THE WATER REGION, as closed rings of raw (unsmoothed) points.
   *
   * Every water hex contributes its core plus the sectors facing water. Edges
   * are counted: shared by two sub-shapes -> interior, discard; seen once -> on
   * the boundary. Keys are rounded so the same edge computed from two different
   * hex centres is recognised as one.
   *
   * Multiple rings are expected and correct: separate lakes each give one, and
   * land entirely enclosed by water gives an interior ring.
   */
  function waterBoundary(mesh, terrainOf) {
    const key = p => Math.round(p[0] * EPS) + "," + Math.round(p[1] * EPS);
    const seen = new Map();       // edge key -> { a, b, count }
    const addEdge = (p, q) => {
      const ka = key(p), kb = key(q);
      if (ka === kb) return;
      const ek = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      const rec = seen.get(ek);
      if (rec) rec.count++;
      else seen.set(ek, { a: ka, b: kb, pa: p, pb: q, count: 1 });
    };
    const addShape = pts => { for (let i = 0; i < pts.length; i++) addEdge(pts[i], pts[(i + 1) % pts.length]); };

    for (const c of mesh.cells) {
      if (terrainOf(c.sub) !== WATER) continue;
      addShape(c.inner);
      for (let k = 0; k < 6; k++) if (waterAcross(mesh, c, k, terrainOf)) addShape(c.sectorPts[k]);
    }

    // boundary edges only, indexed by endpoint
    const edges = [], at = new Map(), pos = new Map();
    for (const e of seen.values()) {
      if (e.count !== 1) continue;
      const i = edges.length;
      edges.push(e);
      pos.set(e.a, e.pa); pos.set(e.b, e.pb);
      if (!at.has(e.a)) at.set(e.a, []);
      if (!at.has(e.b)) at.set(e.b, []);
      at.get(e.a).push(i); at.get(e.b).push(i);
    }

    // walk endpoint to endpoint until we return to the start
    const used = new Set(), rings = [];
    for (let i = 0; i < edges.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const start = edges[i].a;
      let cur = edges[i].b;
      const ring = [pos.get(start), pos.get(cur)];
      while (cur !== start) {
        const next = (at.get(cur) || []).find(j => !used.has(j));
        if (next === undefined) break;               // open chain: malformed input
        used.add(next);
        cur = edges[next].a === cur ? edges[next].b : edges[next].a;
        ring.push(pos.get(cur));
      }
      if (ring.length > 2) rings.push(ring);
    }
    return rings;
  }

  /*
   * Chaikin corner-cutting on a CLOSED ring: every edge is replaced by points at
   * 25% and 75% along it. Purely a function of the input points — no jitter, no
   * randomness — so the same terrain always yields the same shore.
   */
  function smoothRing(ring, passes) {
    let pts = ring;
    // rings carry an explicit closing point; drop it so the wrap-around edge is
    // not a zero-length one, which Chaikin would turn into coincident points
    const a = pts[0], z = pts[pts.length - 1];
    if (pts.length > 1 && Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) {
      pts = pts.slice(0, -1);
    }
    for (let n = 0; n < (passes == null ? SHORE_PASSES : passes); n++) {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
        out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
      }
      pts = out;
    }
    return pts;
  }

  /* every smoothed ring as ONE path string; evenodd makes enclosed land a hole */
  function waterOverlayPath(mesh, terrainOf, passes) {
    return waterBoundary(mesh, terrainOf)
      .map(r => ringPath(smoothRing(r, passes))).join(" ");
  }

  /* ============================================================= *
   * Hex ANCHORS — where a hex's FEATURE sits
   *
   * The shoreline is smoothed, so it cuts THROUGH hexes: a "water" hex may be
   * two-thirds dry land on screen, and a land hex may have water lapping into a
   * corner. Drawing a city or a dungeon at the hex centre therefore drops it in
   * open water often enough to matter.
   *
   * So a hex WITH A FEATURE gets an ANCHOR: a point inside its land part, where
   * the icon, its label, and any road reaching it are drawn. The hex itself does
   * not move — selection and hit-testing stay geometric on the hexagon, so a
   * displaced icon is still picked up by clicking anywhere in its hex.
   *
   * A hex with NO feature is never displaced: its anchor is its centre, full
   * stop. That is not an optimisation, it is the rule. An anchor exists to place
   * an icon; a hex with nothing to place has no reason to move, and displacing
   * it would drag whatever passes through — a river running into a lake would be
   * pulled back onto the bank instead of meeting the water.
   *
   * The anchor is computed against the SMOOTHED rings, not against which sectors
   * were filled with water — Chaikin moves the shore off the sector boundaries,
   * so sector membership no longer says what is land ON SCREEN, which is the
   * only thing the icon cares about.
   *
   * Method: sample a fixed lattice, drop the samples inside the water region
   * (same evenodd rule the fill uses), and keep the survivor FURTHEST from the
   * shore. Sampling is crude but it needs no polygon clipping and it cannot be
   * fooled by a concave shore; features are sparse and anchors are computed
   * lazily, so the cost is irrelevant. Nothing here is random — the lattice is
   * fixed and ties break towards the hex centre, so the editor and the site
   * produce the same anchor for the same terrain, every render.
   * ============================================================= */

  const ICON_R = 8;            // bounding radius of the largest feature icon, px
  const ANCHOR_STEP = 0.274;   // lattice spacing as a fraction of the free radius:
                               // ~40 samples, which is plenty at this hex size
  const ANCHOR_REACH = 2;      // hexes: how far from a water hex the smoothed
                               // shore can possibly stray (one hex, with slack)

  /*
   * The candidate offsets from a hex centre, computed once for the frozen hex
   * size. Generated inside the hexagon ERODED by the icon radius, which is what
   * keeps a displaced icon from hanging over the hex boundary — the clamp is the
   * candidate set, so there is no separate clamping step to get wrong.
   *
   * Sorted by distance from the centre, so equally-clear candidates resolve to
   * the one nearest the centre: the anchor moves as little as the terrain allows.
   */
  let LATTICE = null;
  function anchorLattice() {
    if (LATTICE) return LATTICE;
    const R = G.SIZE - ICON_R * 2 / G.SQ3;     // erode by ICON_R measured on the flats
    const s = R * ANCHOR_STEP;
    const n = Math.ceil(R / s) + 1;
    const pts = [];
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const x = s * (i + j / 2), y = s * (G.SQ3 / 2) * j;   // triangular lattice
        if (G.insidePlate(x, y, R)) pts.push([x, y]);          // same point-up hexagon test
      }
    }
    pts.sort((a, b) =>
      (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    return (LATTICE = pts);
  }

  /* crossing test on ONE ring (smoothed rings carry no duplicate closing point) */
  function insideRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) &&
          x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  /* inside the water REGION: odd number of rings — the evenodd rule the fill uses,
   * so an enclosed island reads as land here exactly as it is painted */
  function inWater(x, y, rings) {
    let n = 0;
    for (const r of rings) if (insideRing(x, y, r)) n++;
    return (n & 1) === 1;
  }

  function distToSeg(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  }
  /* distance from a point to the nearest shoreline segment */
  function shoreClearance(x, y, rings) {
    let best = Infinity;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const d = distToSeg(x, y, r[j][0], r[j][1], r[i][0], r[i][1]);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /* Is any water near enough for the shore to reach this hex? Purely a cheap
   * reject so inland hexes never pay for sampling — a hex it lets through is
   * still decided by the samples. Off-plate is NOT water here: the rim only
   * carries a boundary where the rim hex itself is water. */
  function nearWater(mesh, c, terrainOf) {
    for (let dq = -ANCHOR_REACH; dq <= ANCHOR_REACH; dq++) {
      const lo = Math.max(-ANCHOR_REACH, -dq - ANCHOR_REACH);
      const hi = Math.min(ANCHOR_REACH, -dq + ANCHOR_REACH);
      for (let dr = lo; dr <= hi; dr++) {
        const n = mesh.byKey.get((c.q + dq) + "," + (c.r + dr));
        if (n && terrainOf(n.sub) === WATER) return true;
      }
    }
    return false;
  }

  /*
   * A lazy anchor lookup for one plate: `.of(sub) -> {x, y}`.
   *
   * `hasFeature(sub)` decides which hexes may be displaced at all — only those
   * with something to place. Everything else answers with its own centre without
   * touching the geometry.
   *
   * The rings are built on the first query that needs them and the answers are
   * memoised, so a plate with no coastal features does no work at all. Terrain
   * AND the feature set are inputs: when either changes, build a new index
   * rather than poking this one.
   */
  function anchorIndex(mesh, terrainOf, hasFeature, opts) {
    const cells = new Map(mesh.cells.map(c => [c.sub, c]));
    const cache = new Map();
    let rings = null;

    function compute(c) {
      const home = { x: c.x, y: c.y };
      if (!hasFeature(c.sub)) return home;          // nothing to place: never displaced
      if (!nearWater(mesh, c, terrainOf)) return home;
      if (rings === null) {
        rings = waterBoundary(mesh, terrainOf)
          .map(r => smoothRing(r, opts && opts.passes));
      }
      if (!rings.length) return home;

      let wet = 0, best = null, bestClear = -Infinity;
      for (const [dx, dy] of anchorLattice()) {
        const x = c.x + dx, y = c.y + dy;
        if (inWater(x, y, rings)) { wet++; continue; }
        const d = shoreClearance(x, y, rings);
        if (d > bestClear) { bestClear = d; best = { x, y }; }
      }
      // untouched by water, or nothing but water: the centre, unmoved
      if (!wet || !best) return home;
      return best;
    }

    return {
      of(sub) {
        if (cache.has(sub)) return cache.get(sub);
        const c = cells.get(sub);
        const a = c ? compute(c) : null;
        cache.set(sub, a);
        return a;
      },
    };
  }

  /*
   * THE LAND UNDERLAY: every hex filled, so the smoothed water has something
   * complete to sit on. Land hexes take their own colour. A water hex is filled
   * per sector with the neighbour's colour across that side; where that
   * neighbour is water there is no land colour to borrow, so it falls back to
   * this hex's own nearest land neighbour, and failing that to water (open water
   * is covered by the overlay regardless).
   */
  function meshSubpaths(mesh, terrainOf, owns) {
    const byType = new Map();
    const push = (type, d) => {
      let a = byType.get(type);
      if (!a) byType.set(type, a = []);
      a.push(d);
    };
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
      const here = terrainOf(c.sub);
      if (here !== WATER) { push(here, c.full); continue; }

      let fallback = null;
      for (let k = 0; k < 6 && !fallback; k++) {
        const n = neighbourOf(mesh, c, k);
        const t = n && terrainOf(n.sub);
        if (t && t !== WATER) fallback = t;
      }
      if (!fallback) fallback = WATER;

      push(fallback, c.core);
      for (let k = 0; k < 6; k++) {
        const n = neighbourOf(mesh, c, k);
        const nt = n ? terrainOf(n.sub) : null;
        push(nt && nt !== WATER ? nt : fallback, c.sectors[k]);
      }
    }
    return { byType, grid: grid.join(" ") };
  }

  /* stable, so a rebuild never reshuffles the paths */
  function typeDrawOrder(byType) {
    return [...byType.keys()].sort((a, b) => (a === WATER ? 1 : 0) - (b === WATER ? 1 : 0));
  }

  /*
   * The whole terrain stack, in the one order that has no seams:
   *   a. land underlay — every hex filled, one <path> per terrain type
   *   b. water overlay — the smoothed rings, one <path>
   *   c. hex grid      — the lattice stroke, one <path>, over both so grid lines
   *                      stay visible across water exactly as they do on land
   *
   * `opts.overlayInto` splits the stack: the underlay goes to `parent` and the
   * overlay plus grid to that element instead. The caller can then slip a layer
   * BETWEEN them, which is how rivers get covered by the lake they run into.
   */
  function renderTerrainInto(parent, mesh, terrainOf, colorOf, opts) {
    opts = opts || {};
    const over = opts.overlayInto || parent;
    // `opts.owns` filters the land underlay and the grid to the positions this
    // plate owns. The WATER REGION is deliberately not filtered: it is computed
    // from the full terrain grid so the shoreline runs continuously to the rim
    // and meets its neighbour's, and its fill is opaque, so the overlap costs
    // nothing. Skipping borrowed positions there would tear the coast at seams.
    const { byType, grid } = meshSubpaths(mesh, terrainOf, opts.owns);
    for (const type of typeDrawOrder(byType)) {
      el("path", { d: byType.get(type).join(" "), fill: colorOf(type), stroke: "none" }, parent);
    }
    const water = waterOverlayPath(mesh, terrainOf, opts.passes);
    if (water) el("path", { d: water, fill: colorOf(WATER), "fill-rule": "evenodd", stroke: "none" }, over);
    el("path", {
      d: grid, fill: "none",
      stroke: opts.gridStroke || "rgba(0,0,0,0.16)", "stroke-width": opts.gridWidth || 1,
    }, over);
  }

  /*
   * A chain of hexes -> a curve that passes through the EDGE MIDPOINTS and bends
   * around the interior hexes, starting and ending exactly on the first and last
   * hex.
   *
   * That is the right shape for a RUN, whose interior vertices are all
   * pass-throughs and whose ends are junctions or termini. It was only ever
   * wrong when applied to a whole line, because a line may run straight through
   * a hex where something else joins — and there the curve bends around the
   * centre instead of touching it, so the two lines never met.
   *
   * IN-HEX the route follows the ANCHOR: the ends land on it and a pass-through
   * takes it as the curve's control point, so a road runs to the relocated
   * feature rather than to empty water. The edge midpoints stay midway between
   * the true CENTRES — they are what two neighbouring runs agree on, and moving
   * them would tear the network apart at the hex boundaries.
   */
  const anchorOfPt = p => ({ x: p.ax == null ? p.x : p.ax, y: p.ay == null ? p.y : p.ay });

  function smoothPath(pts) {
    const a0 = anchorOfPt(pts[0]);
    let d = `M ${a0.x.toFixed(1)} ${a0.y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const c = anchorOfPt(pts[i]);
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const L = anchorOfPt(pts[pts.length - 1]);
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

  function buildCategoryGraphs(lines, bySub, offsetFor, styleOf, anchorFor) {
    const graphs = new Map();
    for (const ln of (lines || [])) {
      const st = styleOf(ln.type);
      const cat = st.category || "road";
      let g = graphs.get(cat);
      if (!g) graphs.set(cat, g = { pos: new Map(), adj: new Map(), edge: new Map() });
      // Only ROADS follow anchors — that is what anchors are for, a road reaching
      // a relocated settlement. A river's business is being IN the water, so it
      // routes through centres and runs on into the subhex it ends in.
      const anchored = cat === "road" ? anchorFor : null;
      for (const run of resolveRuns(ln.path, bySub, offsetFor, anchored)) {
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
   *   anchorFor(sub, plate) -> {x,y}|null,
   *   layerFor(category, plateId) -> parent element | null,
   *   localOrigin(plateId) -> {x,y}          // optional
   * }
   *
   * ONE GRAPH MAY SPAN PLATES. The site draws a single plate and takes the
   * simple path: layerFor ignores the plate and nothing is shifted. The editor
   * builds one graph across the whole atlas — which is what makes a road on one
   * plate junction with a road on its neighbour at a shared seam hex — and hands
   * back a different layer per plate, because a river has to sit under ITS OWN
   * plate's water overlay. `localOrigin` is then subtracted so the run lands
   * correctly inside that already-positioned layer.
   *
   * A run is drawn by the first plate along it that HAS a layer, so a run
   * reaching in from an off-screen plate is still drawn rather than dropped.
   */
  function drawLineNetwork(lines, ctx) {
    const { bySub, offsetFor, styleOf, layerFor, anchorFor, localOrigin } = ctx;
    const graphs = buildCategoryGraphs(lines, bySub, offsetFor, styleOf, anchorFor);

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
          return { x: p.x - sx, y: p.y - sy, ax: p.ax - sx, ay: p.ay - sy };
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
       * A junction gets a filled round cap on the hex ANCHOR, sized to the
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
        const st = styleOf(heaviest), p = anchorOfPt(g.pos.get(key));
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
   *   under   every plate's land underlay
   *   water   rivers and streams        ── under the lake fill, so a river
   *   shore   water overlay + hex grid     running into a lake merges with it
   *   road    paths, roads, paved       ── over the water, so a crossing reads
   *   content icons, settlement names,     as a bridge
   *           subhex numbers — all PER HEX; nothing here is per plate
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
      shore:   el("g", {}, world),
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
        gShore: el("g", at, layers.shore),
        gWater: el("g", at, layers.water),      // this plate's share of the water network
        gRoad:  el("g", at, layers.road),       // …and of the road network
        gContent: el("g", at, layers.content),
        built: false, numsBuilt: false, anchors: null,
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
      for (const g of [rec.gUnder, rec.gShore, rec.gWater, rec.gRoad, rec.gContent]) g.remove();
      recs.delete(id);
    }

    function paint(rec, st) {
      rec.gUnder.textContent = "";
      rec.gShore.textContent = "";
      rec.anchors = null;
      renderTerrainInto(rec.gUnder, mesh, s => st.terrain[s] || st.defaultTerrain, colorOf, {
        gridStroke: opts.gridStroke, overlayInto: rec.gShore,
        // a borrowed seam position is the OWNER's to paint, and only theirs
        owns: sub => !own.isBorrowed(rec.id, sub),
      });
      rec.built = true;
      drawIcons(rec, st);
      if (rec.numsBuilt) drawNumbers(rec);
    }

    /* where a plate's FEATURES sit — a hex with one that the shoreline cuts
     * through takes a point inside its land part (see anchorIndex) */
    function anchorsFor(rec, st) {
      if (!rec.anchors) {
        rec.anchors = anchorIndex(mesh,
          s => st.terrain[s] || st.defaultTerrain,
          s => { const c = (st.hexes || {})[s]; return !!(c && c.feature); });
      }
      return rec.anchors;
    }

    function drawIcons(rec, st) {
      rec.gIcons.textContent = "";
      const anchors = anchorsFor(rec, st);
      for (const h of geo) {
        const c = (st.hexes || {})[h.sub];
        if (!c || !c.feature) continue;
        const a = anchors.of(h.sub) || h;
        drawIcon(rec.gIcons, c.feature.type, a.x, a.y, 1);
        if (c.feature.type === "city" || c.feature.type === "town") {
          const t = el("text", {
            x: a.x, y: a.y + 22, "text-anchor": "middle",
            "font-family": "'IM Fell English SC',serif",
            "font-size": c.feature.type === "city" ? 15 : 12, fill: "#2b2b23",
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
        anchorFor: (sub, plate) => {
          const rec = recs.get(plate), st = stateOf(plate);
          return (rec && rec.built && st) ? anchorsFor(rec, st).of(sub) : null;
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
      anchorOf: (plateId, sub) => {
        const rec = recs.get(plateId), st = stateOf(plateId);
        return (rec && rec.built && st) ? anchorsFor(rec, st).of(sub) : bySub.get(sub);
      },
    };
  }

  const PlateDraw = {
    createAtlas, drawIcon, el, resolveRuns, smoothPath, drawLineNetwork,
    terrainMesh, meshSubpaths, typeDrawOrder, sectorDirs, renderTerrainInto,
    waterBoundary, smoothRing, waterOverlayPath,
    plateBoundaryEdges, plateBoundaryPath,
    anchorIndex, anchorLattice, inWater,
    WATER, CORE_R, SHORE_PASSES, ICON_R,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = PlateDraw;
  else global.PlateDraw = PlateDraw;
})(typeof window !== "undefined" ? window : this);
