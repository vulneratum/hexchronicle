#!/usr/bin/env node
/*
 * PHASE A / step 1 — compute the land–sea mask and write it to world/physical/.
 *
 * Stops here on purpose. WORLDGEN §9: "Phase A ends with the land–sea mask
 * rendered as a single image for my approval BEFORE anything else is computed
 * on top of it." Elevation, bathymetry, currents, moisture and drainage all
 * read this file; none of them may be generated until it is signed off.
 */
"use strict";
const fs = require("fs"), path = require("path");
const frame = require("./worldgen/frame.js");
const { buildMask, P } = require("./worldgen/mask.js");
const { hashSeed } = require("./worldgen/noise.js");

const SEED_STR = (process.argv.find(a => a.startsWith("--seed=")) || "").split("=")[1]
  || "hexchronicle-4712";
const seed = hashSeed(SEED_STR);
const mask = buildMask(seed);
const s = mask.stats;

/* ---- invariants that must hold before this is worth showing anyone ---- */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
// §VII-A2 targets are ENFORCED by tools/validate-world.js (rule 11a), which is
// where the brief put them. Reported here so the shape of the world is visible
// in one place, but they do not gate this script.
const warn = (name, ok, detail) => { checks.push({ name, ok, detail, warn: true }); return ok; };

let edgeLand = 0;
for (const c of mask.order) if (c.land && c.edgeMi < 36) edgeLand++;
check("rule 11 — no land within one plate of the frame edge", edgeLand === 0, `${edgeLand} subhexes`);
check("every cell is classified", mask.order.every(c => c.type), "");
check("water in the 40–45% band (the ring wins over the target)",
  s.waterFraction >= 0.395 && s.waterFraction <= 0.455,
  `${(s.waterFraction * 100).toFixed(2)}% — land ${s.landSqMi.toLocaleString()} sq mi`);

/* THE SPLIT — a northern mass off the main body, and nothing else substantial. */
const twoMassShare = (s.landmasses[0] + s.landmasses[1]) / s.land;
check("the channel divides the land into a northern mass and the main body",
  s.continents.length === 2 && twoMassShare > 0.97,
  `${s.continents.map(c => `${c.name} ${c.sqMi.toLocaleString()}`).join(", ")} — ` +
  `${(twoMassShare * 100).toFixed(2)}% of land`);
check("the northern mass is a continent, not an offshore island",
  s.continents[0] && s.continents[0].sqMi > 100000,
  `${s.continents[0] ? s.continents[0].sqMi.toLocaleString() : 0} sq mi`);

/*
 * THE CHANNEL IS A THROUGH-PASSAGE. Being `ocean` is not enough — a dead-end
 * gulf reachable from one side is ocean too. So walk the corridor from beyond
 * the western frame edge to beyond the eastern one and require open water the
 * whole way, and measure what it actually pinches to.
 */
/*
 * Connectivity, NOT an axis sample. The chain now sits on the axis, so sampling
 * it counts every island as a blockage; and a dead-end gulf is `ocean` too, so
 * the type tells us nothing either. What has to be true is that a hull can get
 * from the western frame edge to the eastern one THROUGH the corridor — so
 * flood the corridor's water and see whether both ends are in one component.
 */
const corridor = mask.order.filter(c => !c.land && c.chan > 0.20);
const corrKeys = new Set(corridor.map(c => c.q + "," + c.r));
const seen = new Set();
let west = null;
for (const c of corridor) if (!west || c.u < west.u) west = c;
const stack = [west];
seen.add(west.q + "," + west.r);
while (stack.length) {
  const c = stack.pop();
  for (const [dq, dr] of DIRS) {
    const k = (c.q + dq) + "," + (c.r + dr);
    if (!corrKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    stack.push(mask.cells.get(k));
  }
}
let reachW = 1, reachE = 0;
for (const c of corridor) {
  if (!seen.has(c.q + "," + c.r)) continue;
  if (c.u < reachW) reachW = c.u;
  if (c.u > reachE) reachE = c.u;
}
check("the channel is a THROUGH-PASSAGE — one navigable body, edge to edge",
  reachW < 0.03 && reachE > 0.97,
  `open water reaches u=${reachW.toFixed(3)} in the west and u=${reachE.toFixed(3)} in the east`);

/* Width, measured only where the channel is genuinely BOUNDED by land on both
 * sides — at the mouths it opens into the ocean and has no width to speak of. */
const G = require("../shared/geometry.js");
const b = frame.bounds();
const axis = P.channelAxis;
const at = (uu, vv) => {
  const x = b.minX + uu * (b.maxX - b.minX), y = b.minY + vv * (b.maxY - b.minY);
  const a2 = G.pxToAxial(x, y);
  return mask.cells.get(a2.q + "," + a2.r);
};
// Bank to bank, ignoring the islands. The chain sits ON the axis, so marching
// until ANY land stops at the first islet and reports a 1-subhex strait; what
// makes a chokepoint is the distance between the two CONTINENTS.
const bankCells = new Set();
for (const m2 of mask.masses.slice(0, 2)) for (const c of m2) bankCells.add(c.q + "," + c.r);
const isBank = c => !c || bankCells.has(c.q + "," + c.r);
let minW = Infinity, maxW = 0, minAt = 0, maxAt = 0;
const stepV = 3 / 1133;                          // one subhex in v
for (let i = 0; i <= 200; i++) {
  const u = 0.03 + (i / 200) * 0.94;
  let v = axis[0][1];
  for (let k = 0; k < axis.length - 1; k++) {
    if (u >= axis[k][0] && u <= axis[k + 1][0]) {
      const t = (u - axis[k][0]) / (axis[k + 1][0] - axis[k][0]);
      v = axis[k][1] + t * (axis[k + 1][1] - axis[k][1]);
      break;
    }
  }
  let up = 0, dn = 0, capped = false;
  while (up < 60) { if (isBank(at(u, v - (up + 1) * stepV))) break; up++; }
  if (up >= 60) capped = true;
  while (dn < 60) { if (isBank(at(u, v + (dn + 1) * stepV))) break; dn++; }
  if (dn >= 60) capped = true;
  if (capped) continue;                          // a mouth, not a width
  const w = up + dn + 1;
  if (w < minW) { minW = w; minAt = u; }
  if (w > maxW) { maxW = w; maxAt = u; }
}
check("…pinching to 6–10 subhexes at one end (bank to bank)",
  minW >= 6 && minW <= 10, `narrowest ${minW} subhexes (${minW * 3} mi) at u=${minAt.toFixed(2)}`);
check("…and opening to 30+ at the other",
  maxW >= 30, `widest ${maxW} subhexes (${maxW * 3} mi) at u=${maxAt.toFixed(2)}`);

check("the southern sea reaches the world ocean (§VII-G, rule 14)",
  s.freshBodies.every(n => n < 2000),
  `largest enclosed body ${s.freshBodies[0] || 0} cells`);

/* THE ARCHIPELAGO — the drowned ridge's islands, at the chokepoint. */
const a = s.archipelago;
check("2+ islands over 300 sq mi on the drowned ridge",
  a.overThreeHundred >= 2,
  `${a.overThreeHundred} of ${a.count} — ${a.sizesSqMi.join(", ")} sq mi`);
check("…plus a scatter of smaller ones",
  a.count - a.overThreeHundred >= 3,
  `${a.count - a.overThreeHundred} under 300 sq mi`);
check("shallow shelf recorded around the chain (§VII-B)",
  s.shelfCells > 500, `${s.shelfCells} subhexes`);

/* ORGANIC COASTLINES (§VII-A2 / rule 11a) */
check("ring width varies — not a constant-width margin",
  s.ring.sd >= 0.35 && (s.ring.p90 - s.ring.p10) >= 1.0,
  `min ${s.ring.min} p10 ${s.ring.p10} mean ${s.ring.mean} p90 ${s.ring.p90} sd ${s.ring.sd} plates`);
check("shoreline development index 3.0+ on every landmass",
  s.continents.every(c => c.sdi >= 3.0),
  s.continents.map(c => `${c.name} ${c.sdi}`).join(", "));
warn("no shoreline run over 6 subhexes (rule 11a-b)",
  s.coastRuns.over === 0,
  `${s.coastRuns.over} runs over the cap, longest ${s.coastRuns.worst} subhexes`);

/* ---- per-plate rollup, for §4-B's compact ocean-plate form later ---- */
const perPlate = new Map();
for (const p of frame.plates()) perPlate.set(p.id, { land: 0, ocean: 0, water: 0 });
for (const c of mask.order) perPlate.get(c.owner)[c.type]++;
let allOcean = 0, allLand = 0, coastal = 0;
for (const [, v] of perPlate) {
  const tot = v.land + v.ocean + v.water;
  if (v.ocean === tot) allOcean++;
  else if (v.land === tot) allLand++;
  else coastal++;
}

/*
 * Storage: run-length encoded over the canonical cell order (sorted by r then
 * q), which is the same order frame.subhexLattice() induces once sorted. The
 * map is overwhelmingly contiguous, so RLE turns 187k cells into a few thousand
 * runs; a raw dump would be a 187 KB blob that diffs unreadably on every tweak.
 */
const canonical = mask.order.slice().sort((a, b) => a.r - b.r || a.q - b.q);
const CODE = { land: 0, ocean: 1, water: 2 };
const runs = [];
for (const c of canonical) {
  const t = CODE[c.type];
  const last = runs[runs.length - 1];
  if (last && last[0] === t) last[1]++;
  else runs.push([t, 1]);
}

const out = {
  phase: "A", step: "land-sea mask", generated_by: "tools/phase-a-mask.js",
  world_seed: SEED_STR, seed_uint32: seed,
  frame: { cols: frame.COLS, rows: frame.ROWS, plates: frame.N_PLATES,
           layout: "offset-axial: row r spans q in [-floor(r/2), 35-floor(r/2)]",
           lat_north: frame.LAT_N, lat_south: frame.LAT_S },
  cells: { total: canonical.length, order: "sorted by r, then q",
           codes: { 0: "land", 1: "ocean", 2: "water" } },
  threshold: mask.thresh,
  params: P,
  stats: {
    land: s.land, ocean: s.ocean, water: s.fresh,
    water_fraction: Number(s.waterFraction.toFixed(5)),
    land_sq_mi: s.landSqMi,
    landmasses: s.landmasses, enclosed_water_bodies: s.freshBodies,
    plates: { all_ocean: allOcean, all_land: allLand, coastal, total: frame.N_PLATES },
  },
  checks: checks.map(c => ({ check: c.name, pass: c.ok, detail: c.detail })),
  rle: runs,
};

fs.mkdirSync("world/physical", { recursive: true });
fs.writeFileSync("world/physical/land-sea-mask.json", JSON.stringify(out, null, 1));

for (const c of checks) console.log(`  ${c.ok ? "ok  " : (c.warn ? "WARN" : "FAIL")}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
console.log(`\nplates: ${allOcean} all-ocean · ${allLand} all-land · ${coastal} coastal (of ${frame.N_PLATES})`);
console.log(`runs: ${runs.length}  → world/physical/land-sea-mask.json`);
if (checks.some(c => !c.ok && !c.warn)) process.exit(1);
