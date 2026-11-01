#!/usr/bin/env node
/*
 * tools/forge-export.js — write a World Forge world into the repo as plates.
 *
 *   node tools/forge-export.js [--recipe=world/forge-recipe.json] [--dry-run]
 *
 * The world is rebuilt from its RECIPE (seeds + settings), so the files this
 * writes are exactly the world shown in World Forge for the same recipe. It
 * writes the NATURAL world only — terrain, rivers and streams — per the
 * generation-order rule: nothing made by hands is placed here.
 *
 * Output:
 *   plates/NNNN.yaml               terrain grid, neighbours, river/stream lines
 *   world/physical/survey/NNNN.json  elevation (ft), rainfall (in/yr) and mean
 *                                  temperature (°F) per subhex — derived data,
 *                                  read-only to the editor (guard blocks world/)
 *
 * Plate ids run row by row from the top-left of the map. Seam ownership is the
 * repo's usual rule (lower id owns), applied by shared/geometry.js.
 *
 * Refuses to run if plates/ already holds plates: archive the current map first.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const HexGeo = require("../shared/geometry.js");
const { generateTwoContinents } = require("./worldgen/forge/world2.js");
const { worldToPlates } = require("./worldgen/forge/convert.js");

const ROOT = path.resolve(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);
const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find(x => x.startsWith("--" + k + "=")); return a ? a.split("=")[1] : d; };
const DRY = argv.includes("--dry-run");

const recipe = JSON.parse(fs.readFileSync(P(arg("recipe", "world/forge-recipe.json")), "utf8"));
const existing = fs.existsSync(P("plates")) ? fs.readdirSync(P("plates")).filter(f => /^\d{4}\.ya?ml$/.test(f)) : [];
if (existing.length && !DRY) { console.error(`forge-export: plates/ already holds ${existing.length} plate(s); archive them first.`); process.exit(1); }

const t0 = Date.now();
const w = generateTwoContinents(recipe.west, recipe.east, m => process.stdout.write("\r  " + m.padEnd(60)));
process.stdout.write("\r  laying 36-mile hexes".padEnd(62) + "\n");
const out = worldToPlates(w, HexGeo, { minBasin: 500 });
const { plates, T, S, E, C, NS, BIO } = out;
const geo = HexGeo.buildPlateHexes();
const idx = new Map(plates.map((p, i) => [p.id, i]));
const coordKey = new Map(plates.map(p => [p.coord[0] + "," + p.coord[1], p.id]));

// rivers and streams: edges at or above the drawing threshold, chained into runs per owning plate
const minBasin = recipe.lines.minBasinSqMi, riverRatio = recipe.lines.riverRatio;
const slotPlate = s => (s / NS) | 0, slotSub = s => geo[s % NS].sub;
const down = new Map(), upCount = new Map(), typeOf = new Map();
for (let i = 0; i < E.length; i += 3) {
  if (E[i + 2] < minBasin) continue;
  down.set(E[i], E[i + 1]);
  typeOf.set(E[i], E[i + 2] >= minBasin * riverRatio ? "river" : "stream");
  upCount.set(E[i + 1], (upCount.get(E[i + 1]) || 0) + 1);
}
const onlyUp = new Map(); for (const [u, d] of down) onlyUp.set(d, u);
const linesBy = plates.map(() => []);
const started = new Set();
// a run starts at a source, at a junction's downstream side, at a plate change or at a type change
for (const [a] of down) {
  const up = upCount.get(a) || 0;
  const u = onlyUp.get(a);
  const startHere = up !== 1 || slotPlate(u) !== slotPlate(a) || typeOf.get(u) !== typeOf.get(a);
  if (!startHere || started.has(a)) continue;
  started.add(a);
  const pl = slotPlate(a), type = typeOf.get(a), path = [slotSub(a)];
  let cur = a;
  for (;;) {
    const nx = down.get(cur);
    if (nx === undefined) break;
    const np = slotPlate(nx);
    path.push(np === pl ? slotSub(nx) : plates[np].id + "-" + slotSub(nx));
    if (np !== pl || !down.has(nx) || typeOf.get(nx) !== type || (upCount.get(nx) || 0) !== 1) break;
    cur = nx;
  }
  linesBy[pl].push({ type, path });
}

// the 432-mile continent hex each plate sits in (same nesting rule, one scale up)
const contAxial = p => { const o = HexGeo.plateToPx(p.coord[0], p.coord[1]); return HexGeo.pxToAxial(o.x / 144, o.y / 144); };
const contKeys = [...new Set(plates.map(p => { const a = contAxial(p); return a.r * 10000 + a.q; }))].sort((x, y) => x - y);
const contNum = new Map(contKeys.map((k, i) => [k, i + 1]));

const yq = s => JSON.stringify(String(s));
let written = 0, lineCount = 0;
if (!DRY) { fs.mkdirSync(P("plates"), { recursive: true }); fs.mkdirSync(P("world", "physical", "survey"), { recursive: true }); }
for (let pi = 0; pi < plates.length; pi++) {
  const p = plates[pi];
  const counts = {};
  for (let k = 0; k < NS; k++) { const t = BIO[T[pi * NS + k]]; counts[t] = (counts[t] || 0) + 1; }
  const dflt = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1))[0];
  const nb = {};
  for (const [d, [dq, dr]] of Object.entries(HexGeo.PLATE_DIR)) nb[d] = coordKey.get((p.coord[0] + dq) + "," + (p.coord[1] + dr)) || null;
  const a = contAxial(p);
  const westish = (() => { let w1 = 0, e1 = 0; for (let k = 0; k < NS; k++) { const c = C[pi * NS + k]; if (c === 1) w1++; else if (c === 2) e1++; } return w1 > e1 ? "western" : e1 ? "eastern" : null; })();
  let y = `# Atlas plate ${p.id} (README §3, §4). Generated by tools/forge-export.js from\n`;
  y += `# world/forge-recipe.json — natural world only. Rich per-hex content lives in hexes/.\n\n`;
  y += `id: "${p.id}"\ncontinent_hex: ${contNum.get(a.r * 10000 + a.q)}            # the 432-mile hex this plate sits within\n`;
  y += `name: null\ncanton: null\nrealm: null\ntitle: null\nscale_label: "1 HEX = 3 MILES (1 LEAGUE)"\n`;
  y += `summary: ${yq(westish ? `Surveyed ${westish} continent ground; no account of it has been written yet.` : "Open sea.")}\n\n`;
  y += `# Six adjoining plates (README §3). null = not yet created.\nneighbors:\n`;
  for (const d of ["e", "ne", "nw", "w", "sw", "se"]) y += `  ${d}: ${nb[d] ? `"${nb[d]}"` : "null"}\n`;
  y += `\ndefault_terrain: ${dflt}\n`;
  const over = [];
  for (let k = 0; k < NS; k++) { const t = BIO[T[pi * NS + k]]; if (t !== dflt) over.push(`  "${geo[k].sub}": ${t}`); }
  y += over.length ? `terrain:                     # subhex number -> terrain type (non-default only)\n${over.join("\n")}\n` : `terrain: {}\n`;
  const ls = linesBy[pi];
  lineCount += ls.length;
  if (ls.length) { y += `\nlines:\n`; for (const l of ls) y += `  - type: ${l.type}\n    path: [${l.path.map(x => `"${x}"`).join(", ")}]\n`; }
  else y += `\nlines: []\n`;
  const sv = { id: p.id, units: { elevation: "ft", rainfall: "in/yr", temperature: "°F" }, subs: [], elevation: [], rainfall: [], temperature: [] };
  for (let k = 0; k < NS; k++) { const o = (pi * NS + k) * 4; sv.subs.push(geo[k].sub); sv.elevation.push(S[o]); sv.rainfall.push(S[o + 1]); sv.temperature.push(S[o + 2]); }
  if (!DRY) {
    fs.writeFileSync(P("plates", p.id + ".yaml"), y);
    fs.writeFileSync(P("world", "physical", "survey", p.id + ".json"), JSON.stringify(sv));
  }
  written++;
}
console.log(`forge-export: ${written} plates, ${lineCount} river/stream runs, ${out.stats.subhexes.toLocaleString()} subhexes`);
console.log(`forge-export: western land ${w.stats.westSqMi.toLocaleString()} sq mi · eastern ${w.stats.eastSqMi.toLocaleString()} sq mi · strait ${w.stats.straitMi} mi`);
console.log(`forge-export: ${DRY ? "dry run, nothing written" : "wrote plates/ and world/physical/survey/"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
