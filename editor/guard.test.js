#!/usr/bin/env node
/*
 * Scope-guard tests (README §6). Plain Node asserts — `npm run test:guard`.
 * Proves the editor is STRUCTURALLY unable to write outside map data, and that
 * the comment-preserving writer leaves untouched content (e.g. chronicle) verbatim.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const guard = require("./guard.js");
const yamlIo = require("./yaml-io.js");

let pass = 0;
function ok(name, fn) { fn(); console.log("  ok  " + name); pass++; }
function throws(name, fn) { assert.throws(fn, e => e.scopeViolation === true, "expected ScopeError"); console.log("  ok  " + name); pass++; }

console.log("scope guard:");
ok("accepts plates/",        () => guard.assertInScope("plates/0001.yaml"));
ok("accepts hexes/",         () => guard.assertInScope("hexes/0001-104.yaml"));
ok("accepts theme/",         () => guard.assertInScope("theme/terrain.yaml"));
throws("rejects sessions/",  () => guard.assertInScope("sessions/2026-07.md"));
throws("rejects world/",     () => guard.assertInScope("world/clock.yaml"));
throws("rejects people/",    () => guard.assertInScope("people/npc.yaml"));
throws("rejects realms/",    () => guard.assertInScope("realms/karvosia.yaml"));
throws("rejects hooks/",     () => guard.assertInScope("hooks/harrow.yaml"));
throws("rejects README",     () => guard.assertInScope("README.md"));
throws("rejects docs/",      () => guard.assertInScope("docs/index.html"));
throws("rejects build/",     () => guard.assertInScope("build/build.js"));
throws("rejects .git/",      () => guard.assertInScope(".git/config"));
throws("rejects .. escape",  () => guard.assertInScope("plates/../world/clock.yaml"));
throws("rejects parent esc", () => guard.assertInScope("../secret"));
throws("rejects absolute",   () => guard.assertInScope("/etc/passwd"));
throws("rejects win abs",    () => guard.assertInScope("C:/Windows/System32/x"));

console.log("commit-path allowlist:");
ok("plates path commit-ok",  () => assert.strictEqual(guard.isAllowedCommitPath("plates/0001.yaml"), true));
ok("sessions not commit-ok", () => assert.strictEqual(guard.isAllowedCommitPath("sessions/x.md"), false));

console.log("hex field allowlist:");
ok("accepts feature/name",   () => guard.assertHexFieldsAllowed(["feature", "name"]));
throws("rejects chronicle",  () => guard.assertHexFieldsAllowed(["chronicle"]));
throws("rejects local_memory",() => guard.assertHexFieldsAllowed(["local_memory"]));
throws("rejects unknown key",() => guard.assertHexFieldsAllowed(["world_state"]));

console.log("yaml-io comment/format preservation:");
ok("terrain write keeps comments, quotes keys, drops removed, sorts", () => {
  const tmp = path.join(os.tmpdir(), "hc-plate-test-" + process.pid + ".yaml");
  fs.writeFileSync(tmp, [
    "# leading comment",
    'id: "0001"',
    "default_terrain: plains",
    "terrain:            # inline note",
    '  "003": hills',
    '  "001": water',
    "lines:              # keep me",
    "  - type: river",
    "    path: [\"001\"]",
    "",
  ].join("\n"));
  yamlIo.writePlateTerrain(tmp, { defaultTerrain: "plains", overrides: { "002": "forest", "001": "water" } });
  const out = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  assert.ok(out.includes("# leading comment"), "leading comment lost");
  assert.ok(out.includes("# keep me"), "lines comment lost");
  assert.ok(/"001": water/.test(out), "key 001 not quoted/kept");
  assert.ok(/"002": forest/.test(out), "new key 002 not written quoted");
  assert.ok(!/"003"/.test(out), "removed key 003 should be gone");
  assert.ok(out.indexOf('"001"') < out.indexOf('"002"'), "keys not sorted");
  assert.ok(out.includes("path:"), "lines block clobbered");
});

ok("lines write keeps surrounding comments, quotes subs", () => {
  const tmp = path.join(os.tmpdir(), "hc-lines-test-" + process.pid + ".yaml");
  fs.writeFileSync(tmp, [
    "default_terrain: plains",
    "terrain:",
    '  "001": water',
    "",
    "# Line features (README §4)",
    "lines:",
    "  - type: river",
    '    path: ["001", "002"]',
    "",
  ].join("\n"));
  yamlIo.writePlateLines(tmp, [
    { type: "road", path: ["005", "006", "007"] },
    { type: "stream", path: ["010", "011"] },
  ]);
  const out = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  assert.ok(out.includes("# Line features (README §4)"), "lines comment lost");
  assert.ok(/  - type: road/.test(out), "road line not written");
  assert.ok(/    path: \["005", "006", "007"\]/.test(out), "road path not written as quoted flow seq");
  assert.ok(/  - type: stream/.test(out), "stream line not written");
  assert.ok(!/type: river/.test(out), "old river line should be replaced");
  assert.ok(/terrain:/.test(out) && /"001": water/.test(out), "terrain block clobbered");
});

console.log(`\n${pass} checks passed.`);
