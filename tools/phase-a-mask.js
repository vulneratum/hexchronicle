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

let edgeLand = 0;
for (const c of mask.order) {
  if (!c.land) continue;
  for (const [dq, dr] of DIRS) {
    if (!mask.cells.has((c.q + dq) + "," + (c.r + dr))) { edgeLand++; break; }
  }
}
check("rule 11 — land nowhere touches the frame edge", edgeLand === 0, `${edgeLand} cells`);
check("every cell is classified", mask.order.every(c => c.type), "");
check("water fraction on target",
  Math.abs(s.waterFraction - P.targetWater) < 0.005,
  `${(s.waterFraction * 100).toFixed(2)}% vs ${(P.targetWater * 100).toFixed(0)}%`);

/* THE SPLIT. Two masses, cleanly divided — not one mass, and not a shattered
 * one. The old "99% in a single landmass" invariant is gone with the channel;
 * what has to hold now is that exactly two masses carry essentially all the
 * land and the smaller is big enough to be a continent in its own right. */
const twoMassShare = (s.landmasses[0] + s.landmasses[1]) / s.land;
check("the channel divides the land in two",
  s.landmasses.length >= 2 && twoMassShare > 0.97,
  `${(twoMassShare * 100).toFixed(2)}% of land in the two masses`);
check("the western mass is a continent, not an offshore island",
  s.landmasses[1] / s.land > 0.15,
  `${(s.landmasses[1] / s.land * 100).toFixed(1)}% of land — ${s.continents.find(c => c.side === "west").sqMi.toLocaleString()} sq mi`);
check("the southern sea reaches the world ocean (§VII-G, rule 14)",
  s.freshBodies.every(n => n < 2000),
  `largest enclosed body ${s.freshBodies[0] || 0} cells`);

/* THE ARCHIPELAGO — the drowned ridge's islands, at the chokepoint. */
const a = s.archipelago;
check("2–3 islands over 300 sq mi on the drowned ridge",
  a.overThreeHundred >= 2 && a.overThreeHundred <= 3,
  `${a.overThreeHundred} of ${a.count} — ${a.sizesSqMi.join(", ")} sq mi`);
check("…plus a scatter of smaller ones",
  a.count - a.overThreeHundred >= 3,
  `${a.count - a.overThreeHundred} under 300 sq mi`);
check("shallow shelf recorded around the chain (§VII-B)",
  s.shelfCells > 500, `${s.shelfCells} subhexes`);

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

for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
console.log(`\nplates: ${allOcean} all-ocean · ${allLand} all-land · ${coastal} coastal (of ${frame.N_PLATES})`);
console.log(`runs: ${runs.length}  → world/physical/land-sea-mask.json`);
if (checks.some(c => !c.ok)) process.exit(1);
