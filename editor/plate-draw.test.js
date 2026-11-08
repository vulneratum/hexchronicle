#!/usr/bin/env node
/*
 * Rendering tests for the shared plate-draw core.
 *
 * Terrain is drawn as one plain, straight-edged hexagon per subhex, filled with
 * that subhex's own terrain colour — water and ocean included. There is no
 * blending into neighbours, no smoothed coastline, and no feature displacement:
 * icons, labels and every line end sit on hex centres. These tests pin that.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const jsyaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
/*
 * The renderer fixtures are the PROTOTYPE map, archived at
 * world/archive/prototype/ when the 36x36 frame was generated clean
 * (WORLDGEN §3). These tests assert renderer GEOMETRY -- hexagon fills, line
 * routing, seam ownership -- not which map is live, so they keep reading the
 * archived plates rather than chasing generated output that changes every
 * time the world seed does.
 */
const FIXTURES = path.join(ROOT, "world", "archive", "prototype", "plates");
const HEX_FIXTURES = path.join(ROOT, "world", "archive", "prototype", "hexes");
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
    remove() {},
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
/* every element, depth first */
function allIn(node, out) {
  out = out || [];
  out.push(node);
  for (const c of node.children) allIn(c, out);
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

const flat = t => { const o = {}; for (const h of geo) o[h.sub] = t; return o; };
/* the terrain of a whole plate file, as a plain lookup */
function plateTerrain(id) {
  const plate = jsyaml.load(fs.readFileSync(path.join(FIXTURES, "" + id + ".yaml"), "utf8"));
  const t = flat(plate.default_terrain);
  for (const [s, v] of Object.entries(plate.terrain || {})) t[s] = v;
  return t;
}
/* which subhexes of a plate carry a feature, read from hexes/ as the build does */
function plateFeatures(id) {
  const out = {};
  for (const f of fs.readdirSync(HEX_FIXTURES).filter(f => /\.ya?ml$/i.test(f))) {
    const m = /^(\d{4})-(\d{3})\.ya?ml$/i.exec(f);
    if (!m || m[1] !== id) continue;
    const doc = jsyaml.load(fs.readFileSync(path.join(HEX_FIXTURES, f), "utf8")) || {};
    if (doc.feature && doc.feature.type) out[m[2]] = { feature: doc.feature };
  }
  return out;
}
/* the plate's own line features */
const plateLines = id =>
  (jsyaml.load(fs.readFileSync(path.join(FIXTURES, "" + id + ".yaml"), "utf8")).lines || []);
const theme = jsyaml.load(fs.readFileSync(path.join(ROOT, "theme", "terrain.yaml"), "utf8"));

/* the six corners of a "M x,y L … Z" hexagon subpath */
function corners(d) {
  const nums = d.replace(/[MLZ]/g, " ").trim().split(/[\s,]+/).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

console.log("straight hexes:");

/* ---- 1. every cell is a regular hexagon on its own centre ---- */
{
  let worst = 0, bad = 0;
  for (const c of mesh.cells) {
    const pts = corners(c.full);
    if (pts.length !== 6 || !/^M [^QCA]*Z$/.test(c.full)) { bad++; continue; }
    for (const p of pts) worst = Math.max(worst, Math.abs(Math.hypot(p[0] - c.x, p[1] - c.y) - HexGeo.SIZE));
  }
  ok(bad === 0, "every subhex is one closed six-corner path of straight segments");
  ok(worst < 0.01, `…every corner sits exactly SIZE from its own centre (worst ${worst.toFixed(4)} px)`);
}

/* ---- 2. each hex contributes exactly its own hexagon, in its own colour ---- */
{
  const terrain = plateTerrain("0001");
  const { byType, grid } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);
  let total = 0;
  for (const ds of byType.values()) total += ds.length;
  ok(total === geo.length, `one fill subpath per subhex: ${geo.length} (got ${total})`);
  ok(mesh.cells.every(c => (byType.get(terrain[c.sub]) || []).includes(c.full)),
    "every subhex's hexagon is filed under its OWN terrain type");
  ok(grid.split("Z").length - 1 === geo.length, `the grid stroke covers all ${geo.length} hexes`);
}

/* ---- 3. no blending: a water hex beside land is solid water ---- */
{
  const terrain = plateTerrain("0001");
  const lake = ["067", "068", "079", "080", "081", "091", "092", "093", "105"];
  ok(lake.every(s => terrain[s] === "water"), "subhexes 067-105 of prototype plate 0001 are the lake");
  const { byType } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);
  const water = byType.get("water");
  ok(water.length === lake.length, `the lake is exactly ${lake.length} water hexagons (got ${water.length})`);
  const c067 = mesh.cells.find(c => c.sub === "067");
  ok(water.includes(c067.full) && !(byType.get("plains") || []).includes(c067.full),
    "shore hex 067 is painted water only — it borrows nothing from its plains neighbours");
  const lone = flat("plains");
  lone["080"] = "water";
  const one = PlateDraw.meshSubpaths(mesh, s => lone[s]);
  ok(one.byType.get("water").length === 1 && one.byType.get("plains").length === geo.length - 1,
    "a lone water hex is one whole water hexagon, and its neighbours stay whole land hexagons");
}

/* ---- 4. the terrain stack has no curves, no evenodd overlay ---- */
{
  const t = flat("plains");
  for (const s of ["067", "079", "080", "092"]) t[s] = "ocean";
  t["081"] = "water";
  const node = fakeNode("g");
  PlateDraw.renderTerrainInto(node, mesh, s => t[s], k => "#" + k.slice(0, 3));
  const ds = pathsIn(node);
  ok(ds.every(d => !/[QCSTA]/.test(d)), "terrain output holds only straight M/L/Z commands — no curves");
  ok(node.children.every(c => c.attrs["fill-rule"] !== "evenodd"), "…and no evenodd water overlay");
  const fills = node.children.filter(c => c.attrs.fill !== "none");
  ok(fills.length === 3 && fills.map(c => c.attrs.fill).sort().join(",") === "#oce,#pla,#wat",
    "one fill path per terrain type, each in its own colour — ocean is not painted as water");
  ok(node.children[node.children.length - 1].attrs.fill === "none", "the grid stroke is drawn last");
}

/* ---- 5. the grid can go to its own layer, above the rivers ---- */
{
  const terrain = plateTerrain("0002");
  const under = fakeNode("g"), gridLayer = fakeNode("g");
  PlateDraw.renderTerrainInto(under, mesh, s => terrain[s], k => "#" + k.slice(0, 3), { gridInto: gridLayer });
  ok(under.children.every(c => c.attrs.fill !== "none"), "the lower layer holds only the terrain fills");
  ok(gridLayer.children.length === 1 && gridLayer.children[0].attrs.fill === "none",
    "the grid stroke goes to the layer above");
  const one = fakeNode("g");
  PlateDraw.renderTerrainInto(one, mesh, s => terrain[s], k => "#" + k.slice(0, 3));
  ok(one.children.length === under.children.length + 1, "…and with no split it is the same stack in one layer");
}

/* ---- 6. the water flag no longer changes what is drawn ---- */
{
  ok(theme.types.water && theme.types.water.water && theme.types.ocean && theme.types.ocean.water,
    "theme/terrain.yaml still flags water and ocean with `water: true`");
  const a = flat("plains"), b = flat("plains");
  for (const s of ["067", "079", "080"]) { a[s] = "ocean"; b[s] = "swamp"; }
  const pa = PlateDraw.meshSubpaths(mesh, s => a[s]), pb = PlateDraw.meshSubpaths(mesh, s => b[s]);
  ok(pa.byType.get("ocean").join("|") === pb.byType.get("swamp").join("|")
     && pa.byType.get("plains").join("|") === pb.byType.get("plains").join("|"),
    "a patch of ocean draws the same hexagons as the same patch of swamp — only the colour differs");
}

console.log("compact ocean plates (WORLDGEN §4-B) — no per-subhex records:");

/*
 * A compact ocean plate stores `default_terrain: ocean` and an EMPTY (or
 * near-empty) `terrain:` override map, never 157 explicit entries. The render
 * core must not care: an empty map and an exhaustively-written all-ocean map
 * must produce byte-identical output.
 */
{
  const compact = {};
  const explicit = flat("ocean");
  const a = PlateDraw.meshSubpaths(mesh, s => compact[s] || "ocean");
  const b = PlateDraw.meshSubpaths(mesh, s => explicit[s]);
  ok(a.grid === b.grid, "grid stroke identical whether the map is empty or exhaustively written");
  ok(JSON.stringify([...a.byType]) === JSON.stringify([...b.byType]),
    "fills identical (an empty subhex list renders exactly like a full one)");
  ok(a.byType.size === 1 && a.byType.get("ocean").length === geo.length,
    `a compact ocean plate is ${geo.length} plain ocean hexagons`);
}

/* a sparse islet on an ocean plate is just one land hexagon among ocean ones */
{
  const terrain = flat("ocean");
  const islet = byKey.get("0,0").sub;
  terrain[islet] = "plains";
  const { byType } = PlateDraw.meshSubpaths(mesh, s => terrain[s]);
  const cell = mesh.cells.find(c => c.sub === islet);
  ok(byType.get("plains").length === 1 && byType.get("plains")[0] === cell.full,
    "the islet is exactly its own plains hexagon");
  ok(byType.get("ocean").length === geo.length - 1, "…and every other hex is a whole ocean hexagon");
}

/* seam ownership filters a compact ocean plate exactly like any other */
{
  const own = HexGeo.plateOwnership({ "0001": [0, 0], "0002": [1, 0] });
  const ocean = () => "ocean";
  const { byType: b2, grid: g2 } = PlateDraw.meshSubpaths(mesh, ocean, sub => !own.isBorrowed("0002", sub));
  const borrowedBy2 = own.borrowedSubs("0002");
  ok(borrowedBy2.length === 5, `0002 borrows exactly the 5 shared positions on its one edge with 0001 (got ${borrowedBy2.length})`);
  ok(g2.split("Z").length - 1 === geo.length - borrowedBy2.length, "0002's grid stroke omits every position it merely borrows");
  ok(b2.get("ocean").length === geo.length - borrowedBy2.length, "0002's fills cover only the positions it owns");
  const { byType: b1, grid: g1 } = PlateDraw.meshSubpaths(mesh, ocean, sub => !own.isBorrowed("0001", sub));
  ok(own.borrowedSubs("0001").length === 0, "the lower id never borrows — it always owns its seams");
  ok(g1.split("Z").length - 1 === geo.length && b1.get("ocean").length === geo.length,
    "a compact ocean plate that owns every seam paints the full 157 hexes");
}

console.log("lines run to hex centres:");

const STYLE = t => (t === "river" || t === "stream"
  ? { category: "water", color: "#7ea6c9", width: t === "stream" ? 2 : 3 }
  : { category: "road", color: "#6b5138", width: 2.4 });
function drawnNetwork(id) {
  const water = fakeNode("g"), road = fakeNode("g");
  PlateDraw.drawLineNetwork(plateLines(id), {
    bySub, offsetFor: () => ({ x: 0, y: 0 }), styleOf: STYLE,
    layerFor: cat => (cat === "water" ? water : road),
  });
  return { water: pathsIn(water), road: pathsIn(road), waterNode: water, roadNode: road };
}
const at = h => `${h.x.toFixed(1)} ${h.y.toFixed(1)}`;

/* ---- 7. smoothPath runs centre to centre through the edge midpoints ---- */
{
  const d = PlateDraw.smoothPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]);
  ok(d === "M 0.0 0.0 Q 100.0 0.0 150.0 0.0 L 200.0 0.0",
    "a run starts and ends on hex centres and bends around the pass-through's centre");
  const runs = PlateDraw.resolveRuns(["094", "0003-094"], bySub, () => ({ x: 1000, y: 0 }));
  const h = bySub.get("094");
  ok(runs[0][0].x === h.x && runs[0][1].x === h.x + 1000 && !("ax" in runs[0][0]),
    "resolved points are hex centres only — there is no anchor to follow");
}

/* ---- 8. plate 0002: the river ends on the water subhex's centre ---- */
{
  const n = drawnNetwork("0002");
  // routing never looks at terrain: whatever 076 is painted, the river ends on its centre
  const c76 = at(bySub.get("076"));
  ok(n.water.filter(d => d.endsWith("L " + c76) || d.startsWith("M " + c76)).length === 1,
    "the river's end point is 076's exact centre, like any other line");
}

/* ---- 9. plate 0001: converging streams merge, and run to the lake hex centre ---- */
{
  const n = drawnNetwork("0001");
  const t = plateTerrain("0001");
  ok(["077", "078"].every(s => t[s] !== "water") && t["091"] === "water",
    "0001's streams cross 077 and 078 and end in the water at 091");
  const tail = n.water.filter(d => d.includes(at(bySub.get("091"))));
  ok(tail.length === 1, `the merged tail into the lake is a single run (got ${tail.length})`);
  ok(tail[0].endsWith("L " + at(bySub.get("091"))), "…and it ends on 091's exact centre");
  ok(circlesIn(n.waterNode).length >= 1, "the stream junctions still carry their merge caps");
}

/* ---- 10. roads end on centres, and a road over a river is a crossing ---- */
{
  const n = drawnNetwork("0002");
  for (const s of ["094", "081"]) {
    ok(n.road.some(d => d.startsWith("M " + at(bySub.get(s))) || d.endsWith("L " + at(bySub.get(s)))),
      `a road terminates on ${s}'s centre, where its feature icon sits`);
  }
  const w = fakeNode("g"), r = fakeNode("g");
  PlateDraw.drawLineNetwork([
    { type: "river", path: ["079", "080", "081"] },
    { type: "road", path: ["067", "080", "093"] },
  ], { bySub, offsetFor: () => ({ x: 0, y: 0 }), styleOf: STYLE, layerFor: cat => (cat === "water" ? w : r) });
  ok(circlesIn(w).length === 0 && circlesIn(r).length === 0,
    "a road crossing a river shares no junction — water and road are separate networks");
  ok(pathsIn(w).length === 1 && pathsIn(r).length === 1, "…each drawn as one unbroken run in its own layer");
}

console.log("the atlas draws icons at hex centres:");

/* ---- 11. createAtlas: every icon and label on its centre, no curves in terrain ---- */
{
  const svg = fakeNode("svg");
  const hexes = plateFeatures("0002");
  const st = { terrain: plateTerrain("0002"), defaultTerrain: "plains", hexes, lines: plateLines("0002") };
  const atlas = PlateDraw.createAtlas(svg, {
    registry: { terrain: theme.types },
    stateOf: id => (id === "0002" ? st : null),
    viewportRect: () => ({ xmin: -1000, xmax: 1000, ymin: -1000, ymax: 1000 }),
  });
  atlas.setPlates([{ id: "0002", coord: [0, 0] }]);
  ok(!("anchorOf" in atlas), "the atlas no longer exposes anchors");
  ok(Object.keys(atlas.layers).join(",") === "under,water,grid,road,content,frame,ui",
    "layer order: fills, rivers, grid, roads, content, frame, ui");

  const icons = allIn(atlas.layers.content).filter(n => n.tag === "g" && / scale\(1\)$/.test(n.attrs.transform || ""));
  const feats = Object.keys(hexes);
  ok(feats.length > 0 && icons.length === feats.length, `one icon per feature (${feats.length})`);
  const centres = new Set(feats.map(s => `translate(${bySub.get(s).x} ${bySub.get(s).y}) scale(1)`));
  ok(icons.every(g => centres.has(g.attrs.transform)), "every feature icon is drawn on its hex centre");
  const labels = allIn(atlas.layers.content).filter(n => n.tag === "text" && n.attrs["font-family"] === "'IM Fell English SC',serif");
  ok(labels.every(t => feats.some(s => Number(t.attrs.x) === bySub.get(s).x && Number(t.attrs.y) === bySub.get(s).y + 22)),
    `every settlement label sits under its hex centre (${labels.length} labels)`);

  const terrainDs = pathsIn(atlas.layers.under).concat(pathsIn(atlas.layers.grid));
  ok(terrainDs.length > 0 && terrainDs.every(d => !/[QCSTA]/.test(d)),
    "the atlas terrain and grid hold no curve commands at all");
  ok(allIn(atlas.layers.under).every(n => n.attrs["fill-rule"] !== "evenodd"), "…and no evenodd shoreline overlay");
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
    const ids = fs.readdirSync(FIXTURES)
      .map(f => /^(\d{4})\.ya?ml$/i.exec(f)).filter(Boolean).map(m => m[1]).sort();
    const nb = new Map(ids.map(id =>
      [id, (jsyaml.load(fs.readFileSync(path.join(FIXTURES, id + ".yaml"), "utf8")).neighbors || {})]));
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
    "a borrowed position contributes no fill either — one hex, one painting");
  const allFills = [...all.byType.values()].flat().join(" ");
  ok(cells.every(c => allFills.includes(c.full)),
    "…while the owner still draws every one of them");
}

console.log(`
${pass} checks passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
