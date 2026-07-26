#!/usr/bin/env node
/*
 * Rendering tests for the shared plate-draw core.
 *
 * The one that matters most is the SECTOR-TO-NEIGHBOUR mapping. hexCorners()
 * places vertices at 60k-30 degrees and HexGeo.neighborDirs lists axial offsets
 * in a different order, so an off-by-one is easy — and the result still looks
 * plausible, with the coastline simply on the wrong side of every hex. So it is
 * asserted geometrically: for a water hex with exactly one water neighbour, the
 * water sector must be the one physically FACING that neighbour.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const jsyaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
const HexGeo = require("../shared/geometry.js");

// plate-draw builds SVG nodes at create() time only; the pure geometry helpers
// this file exercises need no DOM. The stub RECORDS what it is given, so the
// line network can be checked as drawn rather than only as computed.
global.HexGeo = HexGeo;
function fakeNode(tag) {
  return {
    tag, attrs: {}, children: [], style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    get textContent() { return ""; },
    set textContent(v) { if (v === "") this.children.length = 0; },
  };
}
global.document = { createElementNS: (ns, tag) => fakeNode(tag) };
/* every <path>'s `d`, depth first */
function pathsIn(node, out) {
  out = out || [];
  if (node.tag === "path" && node.attrs.d) out.push(node.attrs.d);
  for (const c of node.children) pathsIn(c, out);
  return out;
}
function circlesIn(node, out) {
  out = out || [];
  if (node.tag === "circle") out.push(node.attrs);
  for (const c of node.children) circlesIn(c, out);
  return out;
}
const PlateDraw = require("../shared/plate-draw.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok  " : "  NOT OK  ") + msg);
  cond ? pass++ : fail++;
}

const geo = HexGeo.buildPlateHexes();
const bySub = new Map(geo.map(h => [h.sub, h]));
const byKey = new Map(geo.map(h => [h.q + "," + h.r, h]));
const mesh = PlateDraw.terrainMesh(geo);

/* the centroid of a subpath's points, used to ask "which way does this face?" */
function centroid(d) {
  const nums = d.replace(/[MLZ]/g, " ").trim().split(/[\s,]+/).map(Number);
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i + 1 < nums.length; i += 2) { sx += nums[i]; sy += nums[i + 1]; n++; }
  return { x: sx / n, y: sy / n };
}

console.log("sector geometry:");

/* ---- 1. every sector faces its declared neighbour ---- */
{
  let worst = 1;
  for (const c of mesh.cells) {
    for (let k = 0; k < 6; k++) {
      const d = mesh.dirs[k];
      const to = HexGeo.axialToPx(d[0], d[1]);            // direction to that neighbour
      const cen = centroid(c.sectors[k]);
      const vx = cen.x - c_x(c), vy = cen.y - c_y(c);     // direction the sector points
      const dot = (vx * to.x + vy * to.y) / (Math.hypot(vx, vy) * Math.hypot(to.x, to.y));
      if (dot < worst) worst = dot;
    }
  }
  // cos of the angle between sector centroid and neighbour direction; a correct
  // mapping is essentially 1, an off-by-one would be cos(60 deg) = 0.5 or worse
  ok(worst > 0.999, `every sector centroid points at its neighbour (worst cos = ${worst.toFixed(6)})`);
}
function c_x(c) { return bySub.get(c.sub).x; }
function c_y(c) { return bySub.get(c.sub).y; }

/* ---- 2. the mapping is a permutation of the six real neighbours ---- */
{
  const seen = new Set(mesh.dirs.map(d => d.join(",")));
  ok(seen.size === 6, "the six sectors map to six DISTINCT neighbours");
  const real = new Set(HexGeo.neighborDirs.map(d => d.join(",")));
  ok([...seen].every(k => real.has(k)), "each sector direction is a real HexGeo neighbour offset");
}

/* ---- 3. the decisive case: one water neighbour, one water sector ---- */
{
  // a hex well inside the plate, so all six neighbours exist
  const centre = byKey.get("0,0");
  const dir = HexGeo.neighborDirs[3];                     // any direction will do
  const nb = byKey.get((centre.q + dir[0]) + "," + (centre.r + dir[1]));
  const terrain = {};
  for (const h of geo) terrain[h.sub] = "plains";
  terrain[centre.sub] = "water";
  terrain[nb.sub] = "water";

  // The decisive geometric check, now made against the WATER REGION itself:
  // a two-hex lake must lean from the centre hex towards its water neighbour.
  // An off-by-one in the sector mapping would lean it 60 degrees away.
  const rings = PlateDraw.waterBoundary(mesh, s => terrain[s]);
  ok(rings.length === 1, `the two-hex lake is one region (got ${rings.length})`);
  const ring = rings[0];
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p[0]; sy += p[1]; }
  const cen = { x: sx / ring.length, y: sy / ring.length };
  const vx = cen.x - centre.x, vy = cen.y - centre.y;
  const to = HexGeo.axialToPx(dir[0], dir[1]);
  const dot = (vx * to.x + vy * to.y) / (Math.hypot(vx, vy) * Math.hypot(to.x, to.y));
  ok(dot > 0.999, `the water region extends TOWARDS the water neighbour (cos = ${dot.toFixed(6)})`);

  // the underlay beneath it takes each land neighbour's own colour
  const { byType } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);
  const cell = mesh.cells.find(c => c.sub === centre.sub);
  // five sides borrow their own land neighbour's colour; the sixth faces water
  // and falls back to this hex's nearest land neighbour, which is also plains —
  // so the underlay beneath the smoothed shore is plains all the way round
  const plainsSectors = cell.sectors.filter(d => (byType.get("plains") || []).includes(d));
  ok(plainsSectors.length === 6, `the underlay under this hex is entirely plains (got ${plainsSectors.length}/6)`);
}

console.log("blend rules:");

/* ---- 4. land hexes are untouched ---- */
{
  const terrain = {};
  for (const h of geo) terrain[h.sub] = "plains";
  terrain[bySub.get("079").sub] = "swamp";
  const { byType } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);
  const swampCell = mesh.cells.find(c => c.sub === "079");
  ok(byType.get("swamp").length === 1 && byType.get("swamp")[0] === swampCell.full,
    "swamp counts as LAND: one plain hexagon, no sectors");
  ok(!byType.has("water"), "an all-land plate emits no water geometry at all");
  ok(byType.get("plains").every(d => d.split("L").length === 6),
    "every land subpath is a full six-corner hexagon");
}

/* ---- 5. open water is solid; an isolated water hex is just its core ---- */
{
  const terrain = {};
  for (const h of geo) terrain[h.sub] = "water";
  const { byType } = PlateDraw.meshSubpaths(mesh, () => "water");
  ok(byType.size === 1 && byType.has("water"), "an all-water plate is one water path");
  ok(byType.get("water").length === geo.length * 7,
    `open water is core + 6 sectors per hex (${geo.length * 7} subpaths)`);

  const only = {};
  for (const h of geo) only[h.sub] = "plains";
  const lone = byKey.get("0,0");
  only[lone.sub] = "water";
  const cell = mesh.cells.find(c => c.sub === lone.sub);
  const r2 = PlateDraw.waterBoundary(mesh, s => only[s]);
  // 6 corners plus the explicit closing point
  ok(r2.length === 1 && r2[0].length === 7,
    `an isolated water hex's region is ONLY its core — a small lake (got ${r2[0] && r2[0].length} points)`);
  const coreR = Math.hypot(cell.inner[0][0] - lone.x, cell.inner[0][1] - lone.y);
  ok(r2[0].every(p => Math.abs(Math.hypot(p[0] - lone.x, p[1] - lone.y) - coreR) < 1e-6),
    "…and its six points all sit on the core radius");
}

/* ---- 6. the plate rim: water runs to the edge rather than stopping short ---- */
{
  const terrain = {};
  for (const h of geo) terrain[h.sub] = "water";
  const rings = PlateDraw.waterBoundary(mesh, s => terrain[s]);
  ok(rings.length === 1, "an all-water plate is a single region");
  // it must reach the rim rather than stopping a core-radius short of it
  const reach = Math.max(...rings[0].map(p => Math.hypot(p[0], p[1])));
  ok(reach >= HexGeo.RL,
    `the region runs right out to the plate rim (reach ${reach.toFixed(0)} >= RL ${HexGeo.RL})`);
}

/* ---- 7. the real lake in plates/0001.yaml ---- */
{
  const plate = jsyaml.load(fs.readFileSync(path.join(ROOT, "plates/0001.yaml"), "utf8"));
  const terrain = {};
  for (const h of geo) terrain[h.sub] = plate.default_terrain;
  for (const [sub, t] of Object.entries(plate.terrain || {})) terrain[sub] = t;

  const lake = ["067", "068", "079", "080", "081", "091", "092", "093", "105"];
  ok(lake.every(s => terrain[s] === "water"), "subhexes 067-105 really are the lake");

  const { byType, grid } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);

  // 067's northern neighbours are plains -> its shore must be plains, not a generic colour
  const c067 = mesh.cells.find(c => c.sub === "067");
  const shore067 = c067.sectors.filter(d => (byType.get("plains") || []).includes(d));
  ok(shore067.length > 0, "subhex 067 shows a PLAINS shore on its landward sides");

  // due WEST is the sector whose direction vector points at (-1, 0)
  const c079 = mesh.cells.find(c => c.sub === "079");
  const wKey = mesh.dirs.findIndex(d => {
    const p = HexGeo.axialToPx(d[0], d[1]);
    return p.x < 0 && Math.abs(p.y) < 1e-9;
  });
  const wNb = byKey.get((c079.q + mesh.dirs[wKey][0]) + "," + (c079.r + mesh.dirs[wKey][1]));
  ok(wNb.sub === "078" && terrain[wNb.sub] === "plains", "079's western neighbour is 078, plains");
  ok((byType.get("plains") || []).includes(c079.sectors[wKey]),
    "079's western sector is filled with plains — the shore is on the correct side");

  // 080 is the one lake hex with water on all six sides
  const c080 = mesh.cells.find(x => x.sub === "080");
  ok(c080.sectors.every(d => byType.get("water").includes(d)),
    "interior lake hex 080 stays solid water (no land bleeds in)");

  // 092's only land neighbour is 104, which is SWAMP. Its water-facing sides
  // have no land colour to borrow, so the whole underlay falls back to swamp —
  // which is the point: whatever the smoothed shore uncovers there is swamp,
  // never a wrong neighbour's colour and never a sliver of background.
  const c092 = mesh.cells.find(x => x.sub === "092");
  const swamp = byType.get("swamp") || [];
  ok(c092.sectors.every(d => swamp.includes(d)) && swamp.includes(c092.core),
    "092 falls back to its only land neighbour's colour (swamp) across the whole hex");

  ok(grid.split("Z").length - 1 === geo.length,
    `the grid stroke still covers all ${geo.length} full hexes`);
  ok(!/Z/.test(byType.get("plains").join("") ) === false, "land fills are closed subpaths");
}

console.log("water region boundary:");

/* A ring is closed when the walk returns to where it started. */
const closed = ring => {
  const a = ring[0], b = ring[ring.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
};
/* connected components of the water set, by hex adjacency */
function waterComponents(terrain) {
  const water = new Set(geo.filter(h => terrain[h.sub] === "water").map(h => h.q + "," + h.r));
  const seen = new Set();
  let n = 0;
  for (const k of water) {
    if (seen.has(k)) continue;
    n++;
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const [q, r] = stack.pop().split(",").map(Number);
      for (const d of HexGeo.neighborDirs) {
        const nk = (q + d[0]) + "," + (r + d[1]);
        if (water.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
  }
  return n;
}
const flat = t => { const o = {}; for (const h of geo) o[h.sub] = t; return o; };

/* ---- 8. one lone water hex -> exactly one closed ring ---- */
{
  const terrain = flat("plains");
  terrain[byKey.get("0,0").sub] = "water";
  const rings = PlateDraw.waterBoundary(mesh, s => terrain[s]);
  ok(rings.length === 1, `a lone water hex gives 1 ring (got ${rings.length})`);
  ok(rings.every(closed), "the ring is closed");
  ok(waterComponents(terrain) === 1, "…and there is 1 water component, so the counts match");
  // the closing duplicate is dropped first, so 6 real corners -> 6 * 2^2
  const smooth = PlateDraw.smoothRing(rings[0]);
  ok(smooth.length === (rings[0].length - 1) * 4,
    `two Chaikin passes quadruple the point count (${rings[0].length - 1} -> ${smooth.length})`);
  // a smoothed blob must be strictly rounder: no vertex angle as sharp as the hexagon's
  ok(smooth.length > 12, "an isolated lake smooths to a rounded blob, not a hexagon");
}

/* ---- 9. two separate lakes -> two rings ---- */
{
  const terrain = flat("plains");
  terrain[byKey.get("0,0").sub] = "water";
  terrain[byKey.get("5,0").sub] = "water";          // far enough not to touch
  const rings = PlateDraw.waterBoundary(mesh, s => terrain[s]);
  ok(waterComponents(terrain) === 2, "two disjoint water hexes are 2 components");
  ok(rings.length === 2, `…and give 2 rings (got ${rings.length})`);
  ok(rings.every(closed), "both rings are closed");
}

/* ---- 10. land enclosed by water -> an extra interior ring (a hole) ---- */
{
  const terrain = flat("water");
  const island = byKey.get("0,0");
  terrain[island.sub] = "plains";
  const rings = PlateDraw.waterBoundary(mesh, s => terrain[s]);
  ok(waterComponents(terrain) === 1, "the water is a single component");
  ok(rings.length === 2, `one enclosed island adds an interior ring: 1 + 1 = 2 (got ${rings.length})`);
  ok(rings.every(closed), "both rings are closed");
}

/* ---- 11. determinism ---- */
{
  const plate = jsyaml.load(fs.readFileSync(path.join(ROOT, "plates/0001.yaml"), "utf8"));
  const terrain = flat(plate.default_terrain);
  for (const [s, v] of Object.entries(plate.terrain || {})) terrain[s] = v;
  const a = PlateDraw.waterOverlayPath(mesh, s => terrain[s]);
  const b = PlateDraw.waterOverlayPath(mesh, s => terrain[s]);
  ok(a === b && a.length > 0, "the same terrain yields a byte-identical shoreline every render");
}

/* ---- 12. plate 0001's lake ---- */
{
  const plate = jsyaml.load(fs.readFileSync(path.join(ROOT, "plates/0001.yaml"), "utf8"));
  const terrain = flat(plate.default_terrain);
  for (const [s, v] of Object.entries(plate.terrain || {})) terrain[s] = v;

  const rings = PlateDraw.waterBoundary(mesh, s => terrain[s]);
  ok(rings.every(closed), "every ring of plate 0001 is closed");
  ok(rings.length === waterComponents(terrain),
    `ring count matches water components (${rings.length} vs ${waterComponents(terrain)})`);

  // the nine-hex lake must be ONE ring, and it must reach 105's southern tip
  const lake = ["067", "068", "079", "080", "081", "091", "092", "093", "105"];
  const lakePts = lake.map(s => bySub.get(s));
  const inLake = r => r.some(p => lakePts.some(h => Math.hypot(p[0] - h.x, p[1] - h.y) < HexGeo.SIZE));
  const lakeRings = rings.filter(inLake);
  ok(lakeRings.length === 1, `the nine-hex lake is a single ring (got ${lakeRings.length})`);

  const smooth = PlateDraw.smoothRing(lakeRings[0]);
  const tip = bySub.get("105");
  const south = Math.max(...smooth.filter(p => Math.abs(p[0] - tip.x) < HexGeo.SIZE).map(p => p[1]));
  ok(south > tip.y, `105's southern tip survives smoothing as a lobe (reaches y=${south.toFixed(1)}, hex centre y=${tip.y.toFixed(1)})`);

  // the underlay must cover every hex, so the smoothed water never leaves a sliver
  const { byType } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);
  let covered = 0;
  for (const parts of byType.values()) covered += parts.length;
  const waterHexes = geo.filter(h => terrain[h.sub] === "water").length;
  ok(covered === (geo.length - waterHexes) + waterHexes * 7,
    "the land underlay fills every hex (land: 1 subpath, water: core + 6 sectors)");
}

console.log("hex anchors:");

/* the terrain of a whole plate file, as a plain lookup */
function plateTerrain(id) {
  const plate = jsyaml.load(fs.readFileSync(path.join(ROOT, "plates/" + id + ".yaml"), "utf8"));
  const t = flat(plate.default_terrain);
  for (const [s, v] of Object.entries(plate.terrain || {})) t[s] = v;
  return t;
}
const smoothedRings = terrain =>
  PlateDraw.waterBoundary(mesh, s => terrain[s]).map(r => PlateDraw.smoothRing(r));

/*
 * Which subhexes of a plate carry a FEATURE, read from hexes/ the same way the
 * build does. This is what decides whether a hex may be displaced at all: an
 * anchor exists to place an icon, so a hex with nothing to place never moves.
 */
function plateFeatures(id) {
  const set = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, "hexes")).filter(f => /\.ya?ml$/i.test(f))) {
    const m = /^(\d{4})-(\d{3})\.ya?ml$/i.exec(f);
    if (!m || m[1] !== id) continue;
    const doc = jsyaml.load(fs.readFileSync(path.join(ROOT, "hexes", f), "utf8")) || {};
    if (doc.feature && doc.feature.type) set.add(m[2]);
  }
  return set;
}
const has = set => sub => set.has(sub);
const NO_FEATURES = () => false;
/* the plate's own line features */
const plateLines = id =>
  (jsyaml.load(fs.readFileSync(path.join(ROOT, "plates/" + id + ".yaml"), "utf8")).lines || []);

/* distance from a point to the nearest shoreline segment — the test's own
 * implementation, so "furthest from the water" is checked against something
 * other than the code that chose the point */
function shoreDist(x, y, rings) {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const ax = r[j][0], ay = r[j][1], dx = r[i][0] - ax, dy = r[i][1] - ay;
      const len = dx * dx + dy * dy;
      let t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return best;
}

/* ---- 13. the candidate lattice keeps the icon inside its hex ---- */
{
  const lat = PlateDraw.anchorLattice();
  ok(lat.length >= 24 && lat.length <= 96, `a few dozen candidates per hex (${lat.length})`);
  ok(lat[0][0] === 0 && lat[0][1] === 0,
    "the hex centre is the first candidate — the fallback, and the tie-break");

  // hexCorners puts corners at 60k-30 degrees, so the six edge normals are at
  // 60k. A candidate is legal when every edge is at least ICON_R away.
  const inradius = HexGeo.SIZE * HexGeo.SQ3 / 2;
  let worst = Infinity;
  for (const [x, y] of lat) {
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * 60 * k;
      worst = Math.min(worst, inradius - (x * Math.cos(a) + y * Math.sin(a)));
    }
  }
  ok(worst >= PlateDraw.ICON_R - 1e-9,
    `every candidate leaves the icon's bounding radius inside the hex (${worst.toFixed(2)} >= ${PlateDraw.ICON_R})`);
}

/* ---- 14. THE CASE THIS EXISTS FOR: a hex split by the shoreline ----
 * 0002-081 (Morgansfort) and 0002-094 (Old Island Fortress) are both `water`
 * hexes with land on one side. Their centres are under the smoothed water, so
 * an icon drawn there sits in open sea. */
{
  const terrain = plateTerrain("0002");
  const rings = smoothedRings(terrain);
  const feats = plateFeatures("0002");
  const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], has(feats));
  ok(feats.has("081") && feats.has("094"), "0002-081 and 0002-094 do carry features");

  for (const sub of ["081", "094"]) {
    const h = bySub.get(sub), a = idx.of(sub);
    ok(PlateDraw.inWater(h.x, h.y, rings), `${sub}'s hex CENTRE is under water — the bug this fixes`);
    ok(!PlateDraw.inWater(a.x, a.y, rings), `${sub}'s anchor is outside every water ring`);
    const back = HexGeo.pxToAxial(a.x, a.y);
    ok(back.q === h.q && back.r === h.r,
      `${sub}'s anchor is still inside hex ${sub} (moved ${Math.hypot(a.x - h.x, a.y - h.y).toFixed(1)} px)`);

    // …and it is the FURTHEST land candidate from the shore, not merely a dry one
    let bestLand = -Infinity;
    for (const [dx, dy] of PlateDraw.anchorLattice()) {
      const x = h.x + dx, y = h.y + dy;
      if (!PlateDraw.inWater(x, y, rings)) bestLand = Math.max(bestLand, shoreDist(x, y, rings));
    }
    ok(Math.abs(shoreDist(a.x, a.y, rings) - bestLand) < 1e-9,
      `${sub}'s anchor is the land point furthest from the shore (${bestLand.toFixed(1)} px clear)`);
  }

  // the road "094 -> 093" is a two-hex run: it must now start on 094's anchor
  const road = { type: "road", path: ["094", "093"] };
  const runs = PlateDraw.resolveRuns(road.path, bySub, () => ({ x: 0, y: 0 }), s => idx.of(s));
  const a94 = idx.of("094");
  ok(runs.length === 1 && Math.abs(runs[0][0].ax - a94.x) < 1e-9 && Math.abs(runs[0][0].ay - a94.y) < 1e-9,
    "the road out of 094 is routed to 094's anchor, where the dungeon now is");
  ok(runs[0][0].x === bySub.get("094").x && runs[0][0].y === bySub.get("094").y,
    "…while the point's CENTRE is untouched, so edge midpoints do not move");
}

/*
 * ---- 15. the whole rule, checked against a reference implementation ----
 * anchorIndex skips hexes with no water within a couple of rings, which is a
 * speed trick and nothing more. So the rule is restated here in the plainest
 * possible form, with no such shortcut, and every one of the 157 anchors must
 * agree: a hex with no feature, or that the water does not cut, keeps its EXACT
 * centre; a featured hex the water does cut takes the land sample furthest from
 * the shore.
 */
{
  for (const id of ["0001", "0002"]) {
    const terrain = plateTerrain(id);
    const rings = smoothedRings(terrain);
    const feats = plateFeatures(id);
    const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], has(feats));
    let cut = 0, wrong = 0;
    for (const h of geo) {
      let want = { x: h.x, y: h.y };
      if (feats.has(h.sub)) {
        let wet = 0, best = null, bestClear = -Infinity;
        for (const [dx, dy] of PlateDraw.anchorLattice()) {
          const x = h.x + dx, y = h.y + dy;
          if (PlateDraw.inWater(x, y, rings)) { wet++; continue; }
          const d = shoreDist(x, y, rings);
          if (d > bestClear) { bestClear = d; best = { x, y }; }
        }
        if (wet && best) { want = best; cut++; }
      }
      const a = idx.of(h.sub);
      if (a.x !== want.x || a.y !== want.y) wrong++;
    }
    ok(wrong === 0,
      `plate ${id}: all ${geo.length} anchors match the reference (${cut} featured hexes cut by water, the rest exactly on their centre)`);
  }
  // the village at 0002-067 is inland: its icon must not have shifted a pixel
  const t2 = plateTerrain("0002");
  const a67 = PlateDraw.anchorIndex(mesh, s => t2[s], has(plateFeatures("0002"))).of("067");
  const h67 = bySub.get("067");
  ok(a67.x === h67.x && a67.y === h67.y, "the inland village at 0002-067 has not moved");
}

/*
 * ---- 16. A HEX WITH NO FEATURE IS NEVER DISPLACED ----
 * This is the rule that keeps a river reaching the lake it flows into: the
 * lake-edge hexes a river passes through carry nothing, so nothing pulls the
 * water line back onto the bank.
 */
{
  for (const id of ["0001", "0002"]) {
    const terrain = plateTerrain(id);
    const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], NO_FEATURES);
    const moved = geo.filter(h => { const a = idx.of(h.sub); return a.x !== h.x || a.y !== h.y; });
    ok(moved.length === 0,
      `plate ${id}: with no features at all, not one of the ${geo.length} anchors leaves its centre`);
  }
  // …and a featured hex the water does NOT cut is equally untouched
  const terrain = plateTerrain("0002");
  const all = PlateDraw.anchorIndex(mesh, s => terrain[s], () => true);
  const feats = plateFeatures("0002");
  const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], has(feats));
  const wouldMove = geo.filter(h => { const a = all.of(h.sub); return a.x !== h.x || a.y !== h.y; });
  const doMove = geo.filter(h => { const a = idx.of(h.sub); return a.x !== h.x || a.y !== h.y; });
  ok(wouldMove.length > doMove.length && doMove.every(h => feats.has(h.sub)),
    `only featured hexes move: ${doMove.length} of the ${wouldMove.length} hexes the water cuts`);
}

/* ---- 17. an all-water hex has no land to move to: back to the centre ---- */
{
  const terrain = flat("water");
  const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], () => true);
  const off = geo.filter(h => { const a = idx.of(h.sub); return a.x !== h.x || a.y !== h.y; });
  ok(off.length === 0, "on an all-water plate every anchor falls back to the hex centre");
}

/* ---- 18. determinism: the same terrain, the same anchors, every render ---- */
{
  const terrain = plateTerrain("0002"), f = has(plateFeatures("0002"));
  const a = PlateDraw.anchorIndex(mesh, s => terrain[s], f);
  const b = PlateDraw.anchorIndex(mesh, s => terrain[s], f);
  const key = idx => geo.map(h => { const p = idx.of(h.sub); return p.x + "," + p.y; }).join(";");
  ok(key(a) === key(b), "two independent indexes agree on all 157 anchors, bit for bit");
}

console.log("anchored line routing:");

/* ---- 19. anchors move the in-hex routing ONLY ---- */
{
  const pts = [
    { x: 0, y: 0, ax: 5, ay: 5 },          // terminus, displaced
    { x: 100, y: 0, ax: 90, ay: 10 },      // pass-through, displaced
    { x: 200, y: 0, ax: 200, ay: 0 },      // terminus, on its centre
  ];
  const d = PlateDraw.smoothPath(pts);
  ok(d.startsWith("M 5.0 5.0"), "a run starts on the first hex's ANCHOR");
  ok(d.indexOf("Q 90.0 10.0 150.0 0.0") > 0,
    "a pass-through bends around the ANCHOR, towards the midpoint of the true CENTRES");
  ok(/L 200\.0 0\.0$/.test(d), "…and ends on the last hex's anchor");

  // an unanchored point is exactly what it was before anchors existed
  const plainD = PlateDraw.smoothPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]);
  ok(plainD === "M 0.0 0.0 Q 100.0 0.0 150.0 0.0 L 200.0 0.0",
    "points with no anchor route through their centres, unchanged");
}

/* ---- 20. a hex on another plate has no anchor here ---- */
{
  const terrain = plateTerrain("0002");
  const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], has(plateFeatures("0002")));
  const off = { x: 1000, y: 0 };
  const runs = PlateDraw.resolveRuns(["094", "0003-094"], bySub, () => off,
    (sub, plate) => (plate && plate !== "0002") ? null : idx.of(sub));
  const home = bySub.get("094");
  ok(runs[0][1].ax === home.x + off.x && runs[0][1].ay === home.y + off.y,
    "a foreign hex routes through its centre — this plate does not hold that plate's terrain");
  ok(runs[0][0].ax !== home.x, "…while the same subhex on THIS plate keeps its anchor");
}

console.log("rivers meet the water they run into:");

/*
 * The network as DRAWN, per category, for one plate's own lines. Returns the
 * `d` strings that landed in each layer, which is the only way to check both
 * the routing and the layering in one go.
 */
function drawnNetwork(id) {
  const terrain = plateTerrain(id);
  const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], has(plateFeatures(id)));
  const water = fakeNode("g"), road = fakeNode("g");
  PlateDraw.drawLineNetwork(plateLines(id), {
    bySub, offsetFor: () => ({ x: 0, y: 0 }),
    styleOf: t => (t === "river" || t === "stream"
      ? { category: "water", color: "#7ea6c9", width: t === "stream" ? 2 : 3 }
      : { category: "road", color: "#6b5138", width: 2.4 }),
    layerFor: cat => (cat === "water" ? water : road),
    anchorFor: (sub, plate) => (plate && plate !== id) ? null : idx.of(sub),
  });
  return { water: pathsIn(water), road: pathsIn(road), waterNode: water, roadNode: road, idx };
}
const at = h => `${h.x.toFixed(1)} ${h.y.toFixed(1)}`;

/* ---- 21. plate 0002: the river ends ON the water subhex's centre ---- */
{
  const n = drawnNetwork("0002");
  const t = plateTerrain("0002");
  // the river runs 107 -> … -> 076, and both ends are water subhexes
  ok(t["076"] === "water" && t["107"] === "water",
    "0002's river starts and ends in water subhexes (076 and 107)");
  const ends = n.water.filter(d => d.endsWith("L " + at(bySub.get("076")))
                               || d.startsWith("M " + at(bySub.get("076"))));
  ok(ends.length === 1,
    "the river's last point is 076's exact CENTRE — inside the lake, not on the bank");
  // the water region really does cover that point, so the two merge with no gap
  ok(PlateDraw.inWater(bySub.get("076").x, bySub.get("076").y, smoothedRings(t)),
    "…and 076's centre is under the lake fill, which is what hides the join");
}

/* ---- 22. no water line is ever pulled towards an anchor ---- */
{
  for (const id of ["0001", "0002"]) {
    const n = drawnNetwork(id);
    const feats = plateFeatures(id);
    // give EVERY hex a feature: the water lines must still be byte-identical,
    // because water routes through centres whatever the anchors say
    const terrain = plateTerrain(id);
    const greedy = PlateDraw.anchorIndex(mesh, s => terrain[s], () => true);
    const water2 = fakeNode("g"), road2 = fakeNode("g");
    PlateDraw.drawLineNetwork(plateLines(id), {
      bySub, offsetFor: () => ({ x: 0, y: 0 }),
      styleOf: t => (t === "river" || t === "stream"
        ? { category: "water", color: "#7ea6c9", width: t === "stream" ? 2 : 3 }
        : { category: "road", color: "#6b5138", width: 2.4 }),
      layerFor: cat => (cat === "water" ? water2 : road2),
      anchorFor: (sub, plate) => (plate && plate !== id) ? null : greedy.of(sub),
    });
    ok(pathsIn(water2).join("|") === n.water.join("|"),
      `plate ${id}: water lines ignore anchors entirely (${n.water.length} runs, identical either way)`);
  }

  // The CATEGORY is what decides, nothing else: the same path, over the same
  // displaced hex, routes to the anchor as a road and to the centre as a river.
  const terrain = plateTerrain("0002");
  const idx = PlateDraw.anchorIndex(mesh, s => terrain[s], has(plateFeatures("0002")));
  const drawOne = type => {
    const w = fakeNode("g"), r = fakeNode("g");
    PlateDraw.drawLineNetwork([{ type, path: ["094", "093"] }], {
      bySub, offsetFor: () => ({ x: 0, y: 0 }),
      styleOf: t => (t === "river"
        ? { category: "water", color: "#7ea6c9", width: 3 }
        : { category: "road", color: "#6b5138", width: 2.4 }),
      layerFor: cat => (cat === "water" ? w : r),
      anchorFor: s => idx.of(s),
    });
    return pathsIn(w).concat(pathsIn(r))[0];
  };
  const a94 = idx.of("094"), c94 = bySub.get("094");
  ok(drawOne("road").startsWith(`M ${a94.x.toFixed(1)} ${a94.y.toFixed(1)}`),
    "as a ROAD, the 094 -> 093 line starts on the dungeon's anchor");
  ok(drawOne("river").startsWith(`M ${at(c94)}`),
    "as a RIVER, the very same path starts on 094's centre instead");
}

/* ---- 23. plate 0001: the three converging streams still reach the lake ---- */
{
  const n = drawnNetwork("0001");
  const t = plateTerrain("0001");
  ok(["077", "078"].every(s => t[s] !== "water") && t["091"] === "water",
    "0001's streams cross 077 and 078 and end in the water at 091");
  // one merged tail: the shared 077 -> 078 -> 091 stretch is drawn ONCE
  const tail = n.water.filter(d => d.includes(at(bySub.get("091"))));
  ok(tail.length === 1,
    `the merged tail into the lake is a single run (got ${tail.length})`);
  ok(tail[0].endsWith("L " + at(bySub.get("091"))),
    "…and it ends on 091's exact centre, under the lake fill");
  // the junctions where the three streams merge are still capped
  ok(circlesIn(n.waterNode).length >= 1, "the stream junctions still carry their merge caps");
}

/* ---- 24. roads still terminate on the relocated icons ---- */
{
  const n = drawnNetwork("0002");
  const a94 = n.idx.of("094"), a81 = n.idx.of("081");
  const p = q => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  ok(n.road.some(d => d.startsWith("M " + p(a94)) || d.endsWith("L " + p(a94))),
    "a road still terminates on 094's relocated dungeon");
  ok(n.road.some(d => d.startsWith("M " + p(a81)) || d.endsWith("L " + p(a81))),
    "a road still terminates on 081's relocated settlement");
  ok(p(a94) !== at(bySub.get("094")), "…and those anchors really are off-centre");
}

/* ---- 25. the terrain stack can be split so rivers pass under the water ---- */
{
  const terrain = plateTerrain("0002");
  const under = fakeNode("g"), over = fakeNode("g");
  PlateDraw.renderTerrainInto(under, mesh, s => terrain[s], k => "#" + k.slice(0, 3),
    { overlayInto: over });
  ok(under.children.every(c => c.attrs["fill-rule"] !== "evenodd"),
    "the land underlay holds only the per-terrain fills");
  ok(over.children.length === 2 && over.children[0].attrs["fill-rule"] === "evenodd"
     && over.children[1].attrs.fill === "none",
    "the water overlay and the hex grid go to the layer above, so a river can run between them");
  const one = fakeNode("g");
  PlateDraw.renderTerrainInto(one, mesh, s => terrain[s], k => "#" + k.slice(0, 3));
  ok(one.children.length === under.children.length + over.children.length,
    "…and with no split the stack is exactly as it was: same paths, same order");
}

console.log("lines across a plate seam:");

/*
 * A plate boundary runs through subhex CENTRES, so 0001-035 and 0002-023 are the
 * same physical hex (editor/seam.test.js). Three roads meeting there — two owned
 * by one plate, one by the other — have to merge into a junction, exactly as
 * three roads on a single plate always did.
 */
{
  const LATTICE = { "0001": [0, 0], "0002": [1, 0] };
  const own = HexGeo.plateOwnership(LATTICE);
  const worldOf = id => {
    const c = own.coords.get(id);
    return c ? HexGeo.plateToPx(c[0], c[1]) : null;
  };
  const canon = (path, ownerId) => path.map(e => {
    const a = HexGeo.parseAddr(e), o = own.ownerOf(a.plate || ownerId, a.sub);
    return o.plateId + "-" + o.sub;
  });
  const ROAD = { category: "road", color: "#6b5138", width: 2.4 };

  // the seam hex, named by BOTH plates, plus a third branch to make it a junction
  const seam = ["0001-035", "0002-023"];
  ok(canon(["035"], "0001")[0] === canon(["023"], "0002")[0],
    `both plates' names for the seam hex canonicalise to one: ${canon(["023"], "0002")[0]}`);

  const lines = [
    { type: "road", path: canon(["034", "035"], "0001") },   // arrives on 0001
    { type: "road", path: canon(["024", "023"], "0002") },   // arrives on 0002
    { type: "road", path: canon(["036", "035"], "0001") },   // third branch
  ];

  /* ONE graph across both plates — the fix */
  const l1 = fakeNode("g"), l2 = fakeNode("g");
  PlateDraw.drawLineNetwork(lines, {
    bySub, styleOf: () => ROAD,
    offsetFor: worldOf, localOrigin: worldOf,
    layerFor: (cat, plate) => (plate === "0001" ? l1 : l2),
  });
  const caps = circlesIn(l1).concat(circlesIn(l2));
  ok(caps.length === 1, `the three roads make ONE junction at the seam (got ${caps.length} caps)`);

  // …and the cap sits on the shared hex, in the coordinates of the layer it
  // went into: 0001's layer is positioned at 0001, so these are 0001-local
  const h35 = bySub.get("035");
  ok(circlesIn(l1).length === 1 &&
     Math.abs(Number(caps[0].cx) - h35.x) < 0.1 && Math.abs(Number(caps[0].cy) - h35.y) < 0.1,
    "the junction is drawn by the OWNER's plate, at that plate's own local coordinates");

  /* the old way — a graph per plate — cannot see the junction at all */
  const p1 = fakeNode("g"), p2 = fakeNode("g");
  PlateDraw.drawLineNetwork(lines.filter(l => l.path[0].startsWith("0001") || l.path[1].startsWith("0001")).slice(0, 2), {
    bySub, styleOf: () => ROAD, offsetFor: worldOf, localOrigin: worldOf,
    layerFor: () => p1,
  });
  PlateDraw.drawLineNetwork([lines[1]], {
    bySub, styleOf: () => ROAD, offsetFor: worldOf, localOrigin: worldOf,
    layerFor: () => p2,
  });
  ok(circlesIn(p1).length === 0 && circlesIn(p2).length === 0,
    "…whereas two per-plate graphs see only degree-2 vertices and draw no junction — the bug");

  /* a run reaching in from a plate with no layer is still drawn */
  const only2 = fakeNode("g");
  PlateDraw.drawLineNetwork([lines[0]], {
    bySub, styleOf: () => ROAD, offsetFor: worldOf, localOrigin: worldOf,
    layerFor: (cat, plate) => (plate === "0002" ? only2 : null),
  });
  ok(pathsIn(only2).length === 0, "a run with no on-screen plate at all is simply not drawn");
  const both = fakeNode("g");
  PlateDraw.drawLineNetwork([{ type: "road", path: ["0001-034", "0002-024"] }], {
    bySub, styleOf: () => ROAD, offsetFor: worldOf, localOrigin: worldOf,
    layerFor: (cat, plate) => (plate === "0002" ? both : null),
  });
  ok(pathsIn(both).length === 1,
    "a run whose first plate is off screen is drawn by the next plate along, not dropped");
}

console.log("the plate lattice:");

/*
 * The boundary is ONE deduplicated set of edges for the whole map, not a frame
 * per plate. Two things have to hold, and both were broken before:
 *   - the radius must be exactly RL, or adjacent hexagons cannot share a seam
 *   - an edge claimed by two plates must be kept ONCE, or interior seams stroke
 *     at double the weight of the outer border
 */
{
  const at = coords => coords.map(c => {
    const o = HexGeo.plateToPx(c[0], c[1]);
    return { x: o.x, y: o.y };
  });

  // 1. the radius: adjacent centres are SQ3*RL apart, and a hexagon of radius r
  //    tiles at SQ3*r — so only r === RL shares a seam exactly
  const spacing = HexGeo.SQ3 * HexGeo.RL;
  const two = at([[0, 0], [1, 0]]);
  ok(Math.abs(Math.hypot(two[1].x - two[0].x, two[1].y - two[0].y) - spacing) < 1e-9,
    `adjacent plate centres are SQ3*RL apart (${spacing.toFixed(2)} px)`);
  ok(Math.abs(HexGeo.SQ3 * (HexGeo.RL + HexGeo.SIZE * 0.2) - spacing - 9.01) < 0.01,
    "the old RL + SIZE*0.2 radius needed 9.01 px more spacing than exists — that was the doubled line");

  // 2. the counts: 6 edges per plate, less one for every seam two plates share
  const cases = [
    { name: "a lone plate", coords: [[0, 0]], seams: 0 },
    { name: "two neighbours", coords: [[0, 0], [1, 0]], seams: 1 },
    { name: "a straight run of three", coords: [[0, 0], [1, 0], [2, 0]], seams: 2 },
    { name: "a triangle of three", coords: [[0, 0], [1, 0], [0, 1]], seams: 3 },
    // centre + all six neighbours: 6 spokes plus the 6 edges around the ring
    { name: "a full flower of seven", coords: [[0, 0]].concat(Object.values(HexGeo.PLATE_DIR)), seams: 12 },
  ];
  for (const c of cases) {
    const edges = PlateDraw.plateBoundaryEdges(at(c.coords));
    const want = c.coords.length * 6 - c.seams;
    ok(edges.length === want,
      `${c.name}: ${c.coords.length}×6 − ${c.seams} shared = ${want} edges (got ${edges.length})`);
    // a shared edge is seen exactly twice and kept once; an outer edge once
    const shared = edges.filter(e => e.count === 2).length;
    ok(shared === c.seams, `…of which ${c.seams} are interior seams (got ${shared})`);
  }

  // 3. the real repo cluster, from the plate files' own neighbour graph
  {
    const ids = fs.readdirSync(path.join(ROOT, "plates"))
      .map(f => /^(\d{4})\.ya?ml$/i.exec(f)).filter(Boolean).map(m => m[1]).sort();
    const nb = new Map(ids.map(id =>
      [id, (jsyaml.load(fs.readFileSync(path.join(ROOT, "plates", id + ".yaml"), "utf8")).neighbors || {})]));
    const coord = { [ids[0]]: [0, 0] }, queue = [ids[0]];
    while (queue.length) {
      const id = queue.shift(), [q, r] = coord[id];
      for (const [d, [dq, dr]] of Object.entries(HexGeo.PLATE_DIR)) {
        const n = nb.get(id)[d];
        if (!n || !nb.has(n) || coord[n]) continue;
        coord[n] = [q + dq, r + dr]; queue.push(n);
      }
    }
    const placed = Object.keys(coord);
    let seams = 0;
    for (const id of placed) for (const [, n] of Object.entries(nb.get(id))) {
      if (n && coord[n]) seams++;
    }
    seams /= 2;                                   // each seam is declared from both sides
    const edges = PlateDraw.plateBoundaryEdges(at(placed.map(id => coord[id])));
    ok(edges.length === placed.length * 6 - seams,
      `the repo's ${placed.length} plates: ${placed.length * 6} − ${seams} shared = ${placed.length * 6 - seams} edges (got ${edges.length})`);
    ok(edges.every(e => e.count <= 2), "no edge is claimed by more than two plates");
    // and every edge really is RL from one of the centres
    const worst = Math.max(...edges.map(e => Math.min(...placed.map(id => {
      const o = HexGeo.plateToPx(coord[id][0], coord[id][1]);
      return Math.abs(Math.hypot(e.a[0] - o.x, e.a[1] - o.y) - HexGeo.RL);
    }))));
    ok(worst < 1e-9, `every boundary corner sits exactly RL from its plate centre (worst ${worst.toExponential(1)})`);
  }
}

/* ---- a borrowed seam position is painted by its OWNER and nobody else ---- */
{
  const terrain = plateTerrain("0002");
  const own = HexGeo.plateOwnership({ "0001": [0, 0], "0002": [1, 0] });
  const owned = PlateDraw.meshSubpaths(mesh, s => terrain[s], s => !own.isBorrowed("0002", s));
  const all = PlateDraw.meshSubpaths(mesh, s => terrain[s]);

  const borrowed = own.borrowedSubs("0002");
  ok(borrowed.length === 5, `0002 borrows 5 positions from 0001 (got ${borrowed.length})`);
  ok(owned.grid.split("Z").length - 1 === geo.length - borrowed.length,
    `the grid stroke skips them: ${geo.length} − ${borrowed.length} hexagons`);
  ok(all.grid.split("Z").length - 1 === geo.length,
    "…and without the filter it is all 157, exactly as before");

  // the skipped hexes are ABSENT from the fills too, not merely restroked
  const cells = borrowed.map(s => mesh.cells.find(c => c.sub === s));
  const fills = [...owned.byType.values()].flat().join(" ");
  ok(cells.every(c => !fills.includes(c.full)),
    "a borrowed position contributes no land fill either — one hex, one painting");
  const allFills = [...all.byType.values()].flat().join(" ");
  ok(cells.every(c => allFills.includes(c.full) || terrain[c.sub] === PlateDraw.WATER),
    "…while the owner still draws every one of them");
}

console.log(`\n${pass} checks passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
