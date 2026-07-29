#!/usr/bin/env node
/*
 * tools/validate-world.js — WORLDGEN §8.
 *
 * Failures print the ADDRESS and the RULE NUMBER. It does not auto-fix: it
 * reports and stops, so a wrong field is a decision to be taken rather than a
 * thing that quietly repaired itself.
 *
 *   node tools/validate-world.js [--rules=11,11a] [--limit=20]
 *
 * Rules implemented so far — the rest land as their phases do:
 *
 *   11   Land touching the frame edge. Tightened per the brief: NO LAND WITHIN
 *        ONE PLATE (36 miles) of the frame edge, anywhere.
 *   11a  The margin and the coastline are organic, not machined:
 *          a. the border ring is not a constant width
 *          b. no coastal run follows one hex-grid direction for more than 6
 *             subhexes (18 miles)
 *          c. no landmass has a shoreline development index under 3.0
 *
 * §8's other rules (1–10, 12–21) need elevation, drainage, economy, realms and
 * actors, none of which exist yet. They are listed as PENDING rather than
 * silently passing, because a validator that reports "all clear" while checking
 * a fifth of the rules is worse than one that admits its scope.
 */
"use strict";
const mask = require("./worldgen/mask.js");
const { hashSeed } = require("./worldgen/noise.js");
const frame = require("./worldgen/frame.js");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find(x => x.startsWith("--" + k + "="));
  return a ? a.split("=")[1] : d;
};
const LIMIT = Number(arg("limit", 15));
const ONLY = arg("rules", "").split(",").filter(Boolean);
const SEED = arg("seed", "hexchronicle-4712");

const PENDING = [
  [1, "river uphill / splitting / lake in an open basin", "needs drainage (Phase A)"],
  [2, "desert with no rain shadow, interior or cold current", "needs moisture (Phase A)"],
  [3, "settlement over its caloric ceiling with no import lane", "needs G2"],
  [4, "bulk-grain dependency past 20 subhexes with no water", "needs Phase C"],
  [5, "salt-starved region containing a salt source", "needs Phase C"],
  [6, "realm or house with zero open WAC cycles", "needs Phase D"],
  [7, "named actor missing one of the four §VI fields", "needs Phase E"],
  [8, "write outside the allowed paths", "needs a write log"],
  [9, "seam subhex differing between its parent plates", "needs plates/ (G1)"],
  [10, "write to a hex flagged authored:true", "needs plates/ (G1)"],
  [12, "terrain the biome matrix cannot reproduce", "needs the matrix (Phase A)"],
  [13, "terrain id with no row in the constants table", "needs the table (Phase A)"],
  [14, "ocean with no path to the world ocean, or water with one", "checked in-mask; re-checked at G1"],
  [15, "glacier below the snowline / meltwater outside the river graph", "needs Phase A"],
  [16, "glacier, tundra or taiga outside its zone", "needs Phase A"],
  [17, "caloric ceiling without the growing-season modifier", "needs Phase C"],
  [18, "route or campaign ignoring its closure months", "needs Phase C"],
  [19, "region with no climate mode, or a wet Mediterranean summer", "needs Phase A"],
  [20, "settlement, road, border, ruin, name or lair in G1", "needs plates/ (G1)"],
  [21, "waterway class disagreeing with Strahler order", "needs drainage (Phase A)"],
];

const failures = [];
const fail = (rule, address, detail) => failures.push({ rule, address, detail });
const notes = [];

const want = r => !ONLY.length || ONLY.includes(String(r));

console.log(`validate-world — seed "${SEED}"`);
const m = mask.buildMask(hashSeed(SEED));
const { order, cells, stats } = m;

/* ---------------- rule 11 ---------------- */
if (want(11)) {
  let n = 0;
  for (const c of order) {
    if (!c.land) continue;
    if (c.edgeMi < mask.MI_PER_PLATE) {
      if (n < LIMIT) fail(11, `${c.owner}-${c.sub}`,
        `land ${c.edgeMi.toFixed(1)} mi from the frame edge (minimum 36)`);
      n++;
    }
  }
  if (n > LIMIT) notes.push(`rule 11: ${n - LIMIT} further subhexes not listed`);
  console.log(`  rule 11   land within one plate of the frame edge: ${n === 0 ? "none" : n + " subhexes"}`);
}

/* ---------------- rule 11a ---------------- */
if (want("11a")) {
  // (a) the ring must not be a constant width
  const ring = stats.ring;
  const spread = ring.p90 - ring.p10;
  const constant = ring.sd < 0.35 || spread < 1.0;
  console.log(`  rule 11a-a ring width plates: min ${ring.min} p10 ${ring.p10} ` +
    `median ${ring.p50} mean ${ring.mean} p90 ${ring.p90} max ${ring.max} sd ${ring.sd} ` +
    `(${ring.marginRays} margin rays, ${ring.openingRays} through straits)`);
  if (constant) {
    fail("11a", "frame border",
      `border ring is effectively constant width (sd ${ring.sd}, p10–p90 spread ${spread.toFixed(2)} plates)`);
  }
  if (ring.min < 1.0) {
    fail("11a", "frame border", `ring narrows to ${ring.min} plates, under the one-plate floor`);
  }

  // (b) no coastal run longer than 6 subhexes in one direction
  const runs = m.runs;
  console.log(`  rule 11a-b longest shoreline run: ${runs.worst} subhexes ` +
    `(${runs.offenders.length} over the 6-subhex cap, ${runs.contours} contours)`);
  for (const o of runs.offenders.slice(0, LIMIT)) {
    fail("11a", `${o.cell.owner}-${o.cell.sub}`,
      `shoreline runs ${o.len} subhexes (${(o.len * 3)} mi) along [${o.dir}] — cap is 6`);
  }
  if (runs.offenders.length > LIMIT) {
    notes.push(`rule 11a-b: ${runs.offenders.length - LIMIT} further runs not listed`);
  }

  // (c) shoreline development index
  for (const c of stats.continents) {
    console.log(`  rule 11a-c ${c.name} mass: ${c.sqMi.toLocaleString()} sq mi, ` +
      `coast ${c.coastMi.toLocaleString()} mi, SDI ${c.sdi}`);
    if (c.sdi < 3.0) {
      fail("11a", `${c.name} landmass`, `shoreline development index ${c.sdi} is under 3.0`);
    }
  }
}

/* ---------------- report ---------------- */
console.log("");
if (!failures.length) {
  console.log("PASS — no failures for the rules checked.");
} else {
  console.log(`FAIL — ${failures.length} finding(s):\n`);
  for (const f of failures) {
    console.log(`  rule ${String(f.rule).padEnd(4)} ${f.address.padEnd(14)} ${f.detail}`);
  }
}
for (const n of notes) console.log(`  … ${n}`);

console.log(`\nPENDING (${PENDING.length} rules not yet checkable):`);
for (const [r, what, why] of PENDING) {
  console.log(`  rule ${String(r).padEnd(4)} ${what}  —  ${why}`);
}

process.exit(failures.length ? 1 : 0);
