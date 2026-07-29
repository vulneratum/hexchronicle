#!/usr/bin/env node
/*
 * Plate-generator tests (README §6) — `npm run test:gen`.
 * Proves generation is deterministic, complete, faithful to its profile, and
 * — the point of the exercise — incapable of altering a neighbouring plate.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jsyaml = require("js-yaml");

const HexGeo = require("../shared/geometry.js");
const gen = require("./plate-gen.js");
const yamlIo = require("./yaml-io.js");
const guard = require("./guard.js");

const hexes = HexGeo.buildPlateHexes();
const types = jsyaml.load(fs.readFileSync(path.join(guard.REPO_ROOT, "theme/terrain.yaml"), "utf8")).types;

let pass = 0;
function ok(name, fn) { fn(); console.log("  ok  " + name); pass++; }

console.log("generation:");
ok("assigns every subhex exactly once", () => {
  const r = gen.generatePlate({ hexes, types, profile: "lowland", seed: "t1" });
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, hexes.length, "not every subhex assigned");
  assert.strictEqual(hexes.length, 157, "plate should hold 157 subhexes");
});

ok("is deterministic for a given seed", () => {
  const a = gen.generatePlate({ hexes, types, profile: "coastal", seed: "same" });
  const b = gen.generatePlate({ hexes, types, profile: "coastal", seed: "same" });
  assert.deepStrictEqual(a.terrain, b.terrain);
  assert.strictEqual(a.defaultTerrain, b.defaultTerrain);
});

ok("differs across seeds", () => {
  const a = gen.generatePlate({ hexes, types, profile: "coastal", seed: "one" });
  const b = gen.generatePlate({ hexes, types, profile: "coastal", seed: "two" });
  assert.notDeepStrictEqual(a.terrain, b.terrain);
});

ok("only emits terrain keys the theme defines", () => {
  for (const profile of Object.keys(gen.PROFILES)) {
    const r = gen.generatePlate({ hexes, types, profile, seed: "keys-" + profile });
    for (const t of Object.keys(r.counts)) assert.ok(types[t], `unknown terrain "${t}" from ${profile}`);
  }
});

ok("default_terrain is the modal terrain (keeps the grid sparse)", () => {
  const r = gen.generatePlate({ hexes, types, profile: "highland", seed: "modal" });
  const top = Object.entries(r.counts).sort((a, b) => b[1] - a[1])[0][0];
  assert.strictEqual(r.defaultTerrain, top);
  assert.ok(Object.keys(r.terrain).length < hexes.length, "overrides should exclude the default");
  for (const t of Object.values(r.terrain)) assert.notStrictEqual(t, r.defaultTerrain);
});

ok("every weighted terrain gets represented", () => {
  // the bug this guards: an "arid" plate rolling zero mountains
  for (const seed of ["a", "b", "c", "d"]) {
    const r = gen.generatePlate({ hexes, types, profile: "arid", seed });
    assert.ok(r.counts.mountains > 0, `arid seed ${seed} produced no mountains`);
  }
});

console.log("edge seeds (neighbour terrain as a boundary condition):");
ok("projects onto the correct rim, symmetric in all six directions", () => {
  const flat = {};
  for (const h of hexes) flat[h.sub] = "water";
  const bySub = new Map(hexes.map(h => [h.sub, h]));
  const counts = [];
  for (const dir of ["e", "se", "sw", "w", "nw", "ne"]) {
    const seeds = gen.computeEdgeSeeds(hexes, { [dir]: flat });
    counts.push(seeds.length);
    assert.ok(seeds.length > 0, `no seeds for ${dir}`);
    // seeded hexes must sit on the rim, not in the middle of the plate
    for (const s of seeds) {
      const h = bySub.get(s.sub);
      assert.ok(Math.hypot(h.x, h.y) > HexGeo.RL * 0.6, `seed ${s.sub} is not on the rim`);
    }
  }
  assert.strictEqual(new Set(counts).size, 1, "directions gave different seed counts: " + counts);
});

ok("corner hexes are not double-counted across directions", () => {
  const flat = {};
  for (const h of hexes) flat[h.sub] = "forest";
  const all = gen.computeEdgeSeeds(hexes, { e: flat, w: flat, ne: flat, nw: flat, se: flat, sw: flat });
  assert.strictEqual(new Set(all.map(s => s.sub)).size, all.length, "duplicate subhexes in edge seeds");
});

ok("edge seeds survive generation verbatim", () => {
  const flat = {};
  for (const h of hexes) flat[h.sub] = "water";
  const seeds = gen.computeEdgeSeeds(hexes, { e: flat });
  const r = gen.generatePlate({ hexes, types, profile: "highland", seed: "fixed", edgeSeeds: seeds });
  for (const s of seeds) {
    const got = r.terrain[s.sub] || r.defaultTerrain;
    assert.strictEqual(got, s.type, `border hex ${s.sub} was overwritten (${got} != ${s.type})`);
  }
});

console.log("write path:");
ok("writeNewPlate produces parseable YAML the surgical writers can then edit", () => {
  const tmp = path.join(os.tmpdir(), "hc-newplate-" + process.pid + ".yaml");
  const r = gen.generatePlate({ hexes, types, profile: "woodland", seed: "w" });
  yamlIo.writeNewPlate(tmp, {
    id: "0042", continent_hex: 1, name: "Test Plate", canton: "Harrow", realm: "Karvosia",
    profile: "woodland", seed: "w", edgeSeeds: 0, neighbors: { w: "0001" },
    default_terrain: r.defaultTerrain, terrain: r.terrain,
  });

  const doc = jsyaml.load(fs.readFileSync(tmp, "utf8"));
  assert.strictEqual(doc.id, "0042");
  assert.strictEqual(doc.neighbors.w, "0001");
  assert.strictEqual(doc.neighbors.e, null);
  assert.strictEqual(Object.keys(doc.terrain).length, Object.keys(r.terrain).length);

  // the existing writers must be able to take over the file
  yamlIo.writePlateLines(tmp, [{ type: "river", path: ["005", "006"] }]);
  const after = fs.readFileSync(tmp, "utf8");
  assert.strictEqual((after.match(/^lines:/gm) || []).length, 1, "duplicate lines: block");
  const doc2 = jsyaml.load(after);
  assert.strictEqual(doc2.lines.length, 1);
  assert.ok(after.includes("Interior rolled by the editor"), "provenance comment lost");
  fs.unlinkSync(tmp);
});

ok("setPlateNeighbor changes exactly one line and refuses an occupied slot", () => {
  const tmp = path.join(os.tmpdir(), "hc-nb-" + process.pid + ".yaml");
  const src = [
    "id: \"0001\"",
    "neighbors:",
    "  e: null",
    "  ne: null",
    "  nw: null",
    "  w: null",
    "  sw: null",
    "  se: null",
    "",
    "default_terrain: plains",
    "",
  ].join("\n");
  fs.writeFileSync(tmp, src);

  yamlIo.setPlateNeighbor(tmp, "e", "0002");
  const out = fs.readFileSync(tmp, "utf8");
  const changed = src.split("\n").filter((l, i) => l !== out.split("\n")[i]);
  assert.strictEqual(changed.length, 1, "more than one line changed");
  assert.strictEqual(jsyaml.load(out).neighbors.e, "0002");
  assert.strictEqual(jsyaml.load(out).neighbors.se, null);

  assert.throws(() => yamlIo.setPlateNeighbor(tmp, "e", "0009"), /already points at plate 0002/);
  fs.unlinkSync(tmp);
});

ok("assertCreatable refuses to overwrite an existing plate", () => {
  // Make our OWN existing plate rather than asserting against whatever happens
  // to be in plates/. This used to point at plates/0001.yaml, which quietly
  // stopped testing anything the moment the prototype map was archived and
  // plates/ went empty — the assertion passed no exception and the suite failed
  // for a reason that had nothing to do with the guard.
  const live = path.join(__dirname, "..", "plates", "0001.yaml");
  const preexisting = fs.existsSync(live);
  if (!preexisting) fs.writeFileSync(live, 'id: "0001"\n');
  try {
    assert.throws(() => guard.assertCreatable("plates/0001.yaml"), e => e.scopeViolation === true);
  } finally {
    if (!preexisting) fs.unlinkSync(live);
  }
  assert.throws(() => guard.assertCreatable("world/clock.yaml"), e => e.scopeViolation === true);
  guard.assertCreatable("plates/9999.yaml");   // does not exist -> fine
});

console.log(`\n${pass} checks passed.`);
