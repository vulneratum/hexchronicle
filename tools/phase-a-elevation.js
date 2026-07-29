#!/usr/bin/env node
/*
 * PHASE A / step 2 — compute elevation and relief, and write them to
 * world/physical/elevation.json.
 *
 *   node tools/phase-a-elevation.js [--seed=…] [--render=out.png]
 *
 * Every subhex gets an integer elevation in feet (negative for bathymetry) and
 * a relief class derived from the local elevation RANGE. G1 writes both before
 * terrain, because §VII-G resolves terrain from elevation among other inputs.
 */
"use strict";
const fs = require("fs"), path = require("path");
const frame = require("./worldgen/frame.js");
const mask = require("./worldgen/mask.js");
const { buildElevation, elevationStats, E, RELIEF_CODE, RELIEF_NAME } = require("./worldgen/elevation.js");
const { hashSeed } = require("./worldgen/noise.js");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find(x => x.startsWith("--" + k + "="));
  return a ? a.split("=")[1] : d;
};
const SEED_STR = arg("seed", "hexchronicle-4712");
const seed = hashSeed(SEED_STR);

console.log(`seed "${SEED_STR}" → ${seed}`);
const m = mask.buildMask(seed);
buildElevation(seed, m);
const st = elevationStats(m);

/* ---- invariants ---- */
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

check("every subhex has an integer elevation",
  m.order.every(c => Number.isInteger(c.elevation)),
  `${m.order.length.toLocaleString()} subhexes`);
check("every subhex has a relief class",
  m.order.every(c => RELIEF_CODE[c.relief] !== undefined), "");
check("rule 23 — no water subhex carries a positive elevation",
  m.order.every(c => c.land || c.elevation < 0),
  `deepest ${st.sea.min.toLocaleString()} ft, shallowest ${st.sea.max} ft`);
check("all land is above sea level",
  m.order.every(c => !c.land || c.elevation > 0),
  `lowest land ${st.land.min} ft`);
check("relief is derived from RANGE, not height — high flat ground exists",
  m.order.some(c => c.land && c.elevation > 2500 && c.relief === "flat"),
  `${m.order.filter(c => c.land && c.elevation > 2500 && c.relief === "flat").length} high-but-flat subhexes`);
check("…and low broken ground exists",
  m.order.some(c => c.land && c.elevation < 1200 && (c.relief === "hills" || c.relief === "mountains")),
  `${m.order.filter(c => c.land && c.elevation < 1200 && (c.relief === "hills" || c.relief === "mountains")).length} low-but-broken subhexes`);
check("ground exists above the alpine snowline (§1a glacier/tundra need it)",
  st.aboveSnowline > 0, `${st.aboveSnowline.toLocaleString()} subhexes at or above 8,500 ft`);
check("every relief class is populated",
  RELIEF_NAME.every(n => st.relief[n] > 0),
  RELIEF_NAME.map(n => `${n} ${st.relief[n].toLocaleString()}`).join(", "));

/* ---- encode: Int16 elevation, 2-bit relief, both base64 ---- */
const canonical = m.order.slice().sort((a, b) => a.r - b.r || a.q - b.q);
const elev = new Int16Array(canonical.length);
const relief = new Uint8Array(Math.ceil(canonical.length / 4));
for (let i = 0; i < canonical.length; i++) {
  elev[i] = canonical[i].elevation;
  relief[i >> 2] |= RELIEF_CODE[canonical[i].relief] << ((i & 3) * 2);
}

const out = {
  phase: "A", step: "elevation and relief", generated_by: "tools/phase-a-elevation.js",
  world_seed: SEED_STR, seed_uint32: seed,
  depends_on: "world/physical/land-sea-mask.json",
  units: { elevation: "feet, integer, negative for bathymetry" },
  cells: {
    total: canonical.length, order: "sorted by r, then q",
    elevation_encoding: "base64 of Int16Array little-endian",
    relief_encoding: "base64 of 2 bits per cell, 4 per byte, low bits first",
    relief_codes: RELIEF_NAME,
  },
  params: E,
  stats: st,
  checks: checks.map(c => ({ check: c.name, pass: c.ok, detail: c.detail })),
  elevation: Buffer.from(elev.buffer, elev.byteOffset, elev.byteLength).toString("base64"),
  relief: Buffer.from(relief).toString("base64"),
};

fs.mkdirSync("world/physical", { recursive: true });
fs.writeFileSync("world/physical/elevation.json", JSON.stringify(out, null, 1));

for (const c of checks) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
}
console.log(`
elevation
  land   min ${st.land.min} · median ${st.land.p50} · p90 ${st.land.p90} · p99 ${st.land.p99} · max ${st.land.max.toLocaleString()} ft   (mean ${st.land.mean})
  sea    shallowest ${st.sea.max} · median ${st.sea.p50.toLocaleString()} · deepest ${st.sea.min.toLocaleString()} ft   (mean ${st.sea.mean.toLocaleString()})
  above 8,500 ft: ${st.aboveSnowline.toLocaleString()} subhexes

relief (all subhexes)   ${RELIEF_NAME.map(n => `${n} ${st.relief[n].toLocaleString()}`).join(" · ")}
relief (land only)      ${RELIEF_NAME.map(n => `${n} ${st.reliefLand[n].toLocaleString()} (${(st.reliefLand[n] / st.land.n * 100).toFixed(1)}%)`).join(" · ")}

ranges (§VII-C)`);
for (const sp of E.spines) console.log(`  ${sp.name.padEnd(20)} peak ${String(sp.peakFt).padStart(6)} ft   ${sp.cause}`);
console.log(`\nwrote world/physical/elevation.json`);

const render = arg("render", null);
if (render) require("./render-elevation.js")(m, render);

if (checks.some(c => !c.ok)) process.exit(1);
