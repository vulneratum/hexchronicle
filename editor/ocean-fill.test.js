#!/usr/bin/env node
/*
 * Compact-ocean-plate tests (WORLDGEN §4-B) — `npm run test:fill`.
 * Covers the pure validation/warning logic in ocean-fill.js, the surgical
 * yaml-io.writePlateFill writer, and the guard allowlist for the fill
 * endpoint. Rendering itself (empty subhex list, seam behaviour) is proved in
 * plate-draw.test.js and seam.test.js — this file is the data layer only.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const oceanFill = require("./ocean-fill.js");
const yamlIo = require("./yaml-io.js");
const guard = require("./guard.js");

let pass = 0;
function ok(name, fn) { fn(); console.log("  ok  " + name); pass++; }
function throwsMsg(name, fn, re) {
  assert.throws(fn, re ? e => re.test(e.message) : undefined);
  console.log("  ok  " + name); pass++;
}

console.log("normalizeDepth / normalizeCurrent:");
ok("defaults to shelf", () => assert.strictEqual(oceanFill.normalizeDepth(undefined), "shelf"));
ok("accepts deep", () => assert.strictEqual(oceanFill.normalizeDepth("deep"), "deep"));
throwsMsg("rejects unknown depth", () => oceanFill.normalizeDepth("abyssal"), /unknown depth/);
ok("no current is null", () => assert.strictEqual(oceanFill.normalizeCurrent(null), null));
ok("normalizes a valid current", () => {
  assert.deepStrictEqual(oceanFill.normalizeCurrent({ direction: "nw", temperature: "cold" }),
    { direction: "nw", temperature: "cold" });
});
throwsMsg("rejects bad direction", () => oceanFill.normalizeCurrent({ direction: "north", temperature: "warm" }), /direction/);
throwsMsg("rejects bad temperature", () => oceanFill.normalizeCurrent({ direction: "e", temperature: "hot" }), /temperature/);

console.log("enclosure warning (rule 14 — ocean must reach the world ocean):");
const THEME = { types: { ocean: { water: true }, water: { water: true }, plains: {} } };
ok("no warning with an empty neighbour slot (an escape route)", () => {
  const adjacency = { e: "a", ne: "b", nw: "c", w: "d", sw: "e" };   // only 5 of 6
  assert.strictEqual(oceanFill.enclosureWarning(THEME, adjacency, []), null);
});
ok("no warning when a neighbour's border touches water", () => {
  const adjacency = { e: "a", ne: "b", nw: "c", w: "d", sw: "e", se: "f" };
  const seeds = [{ sub: "001", type: "plains" }, { sub: "002", type: "ocean" }];
  assert.strictEqual(oceanFill.enclosureWarning(THEME, adjacency, seeds), null);
});
ok("warns when fully surrounded and no border is water", () => {
  const adjacency = { e: "a", ne: "b", nw: "c", w: "d", sw: "e", se: "f" };
  const seeds = [{ sub: "001", type: "plains" }, { sub: "002", type: "plains" }];
  const w = oceanFill.enclosureWarning(THEME, adjacency, seeds);
  assert.ok(w && /landlocked/i.test(w), "expected a landlocked warning, got: " + w);
});

console.log("guard: fill allowlist:");
ok("accepts fill/depth/current", () => guard.assertPlateFillAllowed(["fill", "depth", "current"]));
ok("rejects an unknown key as a ScopeError", () => {
  assert.throws(() => guard.assertPlateFillAllowed(["terrain"]), e => e.scopeViolation === true);
});

console.log("yaml-io.writePlateFill — surgical, byte-for-byte elsewhere:");
function tmpPlate(extra) {
  const p = path.join(os.tmpdir(), "hc-fill-test-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".yaml");
  fs.writeFileSync(p, [
    "# leading comment",
    'id: "0099"',
    "name: \"Plate 0099\"",
    "",
    "default_terrain: plains",
    (extra || []).join("\n"),
    "terrain:            # inline note",
    '  "003": hills',
    "",
    "lines:              # keep me",
    "  - type: river",
    "    path: [\"001\"]",
    "",
  ].filter(l => l !== "").join("\n"));
  return p;
}

ok("writes fill/depth/current between default_terrain and terrain", () => {
  const p = tmpPlate();
  yamlIo.writePlateFill(p, { fill: "ocean", depth: "shelf", current: { direction: "nw", temperature: "warm" } });
  const out = fs.readFileSync(p, "utf8");
  fs.unlinkSync(p);
  assert.ok(out.includes("# leading comment"), "leading comment lost");
  assert.ok(out.includes("# keep me"), "lines comment lost");
  assert.ok(/^fill: ocean$/m.test(out), "fill line missing");
  assert.ok(/^depth: shelf$/m.test(out), "depth line missing");
  assert.ok(/^current:$/m.test(out) && /^\s+direction: nw$/m.test(out) && /^\s+temperature: warm$/m.test(out), "current block missing");
  assert.ok(out.indexOf("fill: ocean") < out.indexOf("\nterrain:"), "fill block not before terrain:");
  assert.ok(out.indexOf("default_terrain:") < out.indexOf("fill: ocean"), "fill block not after default_terrain:");
  assert.ok(/"003": hills/.test(out), "terrain grid clobbered");
});

ok("omits current entirely when there is none", () => {
  const p = tmpPlate();
  yamlIo.writePlateFill(p, { fill: "ocean", depth: "deep", current: null });
  const out = fs.readFileSync(p, "utf8");
  fs.unlinkSync(p);
  assert.ok(!/current:/.test(out), "current block should be absent");
  assert.ok(/^depth: deep$/m.test(out));
});

ok("fill: null clears a previously-written block (explode)", () => {
  const p = tmpPlate(["fill: ocean", "depth: shelf", "current:", "  direction: e", "  temperature: cold"]);
  yamlIo.writePlateFill(p, { fill: null, depth: null, current: null });
  const out = fs.readFileSync(p, "utf8");
  fs.unlinkSync(p);
  assert.ok(!/fill:/.test(out) && !/depth:/.test(out) && !/current:/.test(out), "fill block should be gone entirely");
  assert.ok(/"003": hills/.test(out), "terrain grid clobbered");
  assert.ok(out.includes("default_terrain: plains") && out.includes("terrain:"), "surrounding structure lost");
});

ok("a plate that never had a fill block round-trips byte-identical when cleared again", () => {
  const p = tmpPlate();
  const before = fs.readFileSync(p, "utf8");
  yamlIo.writePlateFill(p, { fill: null });
  const after = fs.readFileSync(p, "utf8");
  fs.unlinkSync(p);
  assert.strictEqual(after, before, "clearing an already-absent fill block should be a no-op");
});

console.log("writeNewPlate — the create-as-full-ocean header comment:");
ok("uses the ocean provenance comment and emits the fill block", () => {
  const p = path.join(os.tmpdir(), "hc-newocean-" + process.pid + ".yaml");
  yamlIo.writeNewPlate(p, {
    id: "0099", continent_hex: 1, name: "Deep Water", neighbors: { w: "0001" },
    default_terrain: "ocean", fill: "ocean", depth: "deep", current: null, terrain: {},
  });
  const out = fs.readFileSync(p, "utf8");
  fs.unlinkSync(p);
  assert.ok(out.includes("Created as a full-ocean plate"), "ocean provenance comment missing");
  assert.ok(!out.includes("profile"), "land-generation comment should not appear");
  assert.ok(/^fill: ocean$/m.test(out) && /^depth: deep$/m.test(out));
  assert.ok(!/current:/.test(out));
});

console.log(`\n${pass} checks passed.`);
