#!/usr/bin/env node
/*
 * HexChronicle build — the walking skeleton (README §9 step 1).
 *
 * Reads the repo's data files (the single source of truth, README §4),
 * compiles them into a world-state object, and emits a self-contained
 * docs/index.html you can open directly in a browser (no server).
 *
 *   data files ─▶ build.js ─▶ docs/  (data → build → view)
 *
 * Visibility (README §4): only `public` content is compiled in. `gm-only`
 * hex content is dropped here at build time and never reaches the browser.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const HexGeo = require("../shared/geometry.js");

const ROOT = path.resolve(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);

// Custom domain for GitHub Pages. Emitted as docs/CNAME on every build so a
// rebuild never drops it (README §8). Change here if the domain ever changes.
const CUSTOM_DOMAIN = "hexchronicle.com";

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function die(msg) {
  console.error("build: ERROR — " + msg);
  process.exit(1);
}

/* ---------- load registries + plate + hexes ---------- */
const theme = readYaml(P("theme", "terrain.yaml"));
const registry = { terrain: theme.types || {}, features: theme.features || {} };

// For the skeleton we build the one plate 0001. (Multi-plate discovery is a
// later step; the loop below is already written to generalize.)
const PLATE_ID = "0001";
const plate = readYaml(P("plates", PLATE_ID + ".yaml"));
if (plate.id !== PLATE_ID) die(`plates/${PLATE_ID}.yaml has id "${plate.id}"`);

/* ---------- geometry + numbering (shared with the renderer) ---------- */
const geo = HexGeo.buildPlateHexes();
const N = geo.length;
const validSub = new Set(geo.map(h => h.sub));

/* ---------- resolve terrain for every subhex ---------- */
const defaultTerrain = plate.default_terrain;
if (!registry.terrain[defaultTerrain]) die(`default_terrain "${defaultTerrain}" is not in theme/terrain.yaml`);
const terrainByNum = {};
for (const h of geo) terrainByNum[h.sub] = defaultTerrain;
for (const [sub, type] of Object.entries(plate.terrain || {})) {
  if (!validSub.has(sub)) die(`plate terrain references subhex "${sub}", which is out of range (001..${String(N).padStart(3, "0")})`);
  if (!registry.terrain[type]) die(`terrain type "${type}" (subhex ${sub}) is not defined in theme/terrain.yaml`);
  terrainByNum[sub] = type;
}

/* ---------- load per-hex content files, honoring visibility ---------- */
const hexContent = {};
const hexDir = P("hexes");
let publicCount = 0, gmDropped = 0;
if (fs.existsSync(hexDir)) {
  for (const file of fs.readdirSync(hexDir).filter(f => /\.ya?ml$/i.test(f)).sort()) {
    const doc = readYaml(path.join(hexDir, file)) || {};
    const address = doc.address || file.replace(/\.ya?ml$/i, "");
    const m = /^(\d{4})-(\d{3})$/.exec(address);
    if (!m) die(`hexes/${file}: address "${address}" is not in NNNN-NNN form`);
    if (m[1] !== PLATE_ID) continue;            // belongs to another plate
    const sub = m[2];
    if (!validSub.has(sub)) die(`hexes/${file}: subhex ${sub} is out of range for plate ${PLATE_ID}`);

    // Visibility: the site renders public only (README §4). gm-only content
    // is dropped entirely and never compiled into the browser payload.
    if ((doc.visibility || "public") === "gm-only") { gmDropped++; continue; }

    const entry = {};
    if (doc.feature && doc.feature.type) {
      if (!registry.features[doc.feature.type]) die(`hexes/${file}: feature type "${doc.feature.type}" not in theme/terrain.yaml`);
      entry.feature = { type: doc.feature.type, name: doc.feature.name || null };
    }
    if (doc.local_memory) entry.local_memory = String(doc.local_memory).trim();
    if (Array.isArray(doc.chronicle)) {
      entry.chronicle = doc.chronicle
        .filter(c => (c.visibility || "public") !== "gm-only")
        .map(c => ({ date: c.date || "", text: c.text || "" }));
      if (!entry.chronicle.length) delete entry.chronicle;
    }
    hexContent[sub] = entry;
    publicCount++;
  }
}

/* ---------- validate line features ---------- */
const lines = (plate.lines || []).map((ln, i) => {
  const pth = (ln.path || []).map(String);
  for (const sub of pth) if (!validSub.has(sub)) die(`plate line #${i + 1} (${ln.type}) references subhex "${sub}", out of range`);
  return { type: ln.type, path: pth };
});

/* ---------- assemble compiled world-state ---------- */
const WORLD = {
  generatedFrom: "repo data files (README §4)",
  plate: {
    id: plate.id,
    continent_hex: plate.continent_hex,
    name: plate.name,
    title: plate.title || plate.name,
    canton: plate.canton,
    realm: plate.realm,
    scale_label: plate.scale_label,
    summary: plate.summary ? String(plate.summary).trim() : "",
    default_terrain: defaultTerrain,
    neighbors: plate.neighbors || { e: null, ne: null, nw: null, w: null, sw: null, se: null },
  },
  registry,
  terrainByNum,
  hexContent,
  lines,
};

/* ---------- render docs/ (self-contained: everything inlined) ---------- */
const template = fs.readFileSync(P("build", "template.html"), "utf8");
const geometryJs = fs.readFileSync(P("shared", "geometry.js"), "utf8");
const plateDrawJs = fs.readFileSync(P("shared", "plate-draw.js"), "utf8");
const rendererJs = fs.readFileSync(P("build", "renderer.js"), "utf8");

// Guard the JSON against an accidental </script> in future prose content.
const dataJson = JSON.stringify(WORLD, null, 0).replace(/<\//g, "<\\/");

const html = template
  .replace("/*__GEOMETRY_JS__*/", () => geometryJs)
  .replace("/*__PLATEDRAW_JS__*/", () => plateDrawJs)
  .replace("/*__WORLD_DATA__*/", () => dataJson)
  .replace("/*__RENDERER_JS__*/", () => rendererJs);

const DOCS = P("docs");
fs.mkdirSync(path.join(DOCS, "world"), { recursive: true });
fs.writeFileSync(path.join(DOCS, "index.html"), html);
// Also emit the compiled state on its own, for inspection / future consumers.
fs.writeFileSync(path.join(DOCS, "world", "plate-" + PLATE_ID + ".json"), JSON.stringify(WORLD, null, 2));
// CNAME tells GitHub Pages the custom domain; regenerated so it always persists.
fs.writeFileSync(path.join(DOCS, "CNAME"), CUSTOM_DOMAIN + "\n");
// .nojekyll: serve files as-is (skip Jekyll processing) — belt-and-suspenders.
fs.writeFileSync(path.join(DOCS, ".nojekyll"), "");

/* ---------- report ---------- */
console.log(`build: plate ${PLATE_ID} "${plate.name}"`);
console.log(`build:   ${N} subhexes · ${Object.keys(plate.terrain || {}).length} terrain overrides · ${lines.length} line features`);
console.log(`build:   ${publicCount} public hex files compiled` + (gmDropped ? `, ${gmDropped} gm-only dropped` : ""));
console.log(`build:   wrote docs/index.html and docs/world/plate-${PLATE_ID}.json`);
console.log(`build: done. Open docs/index.html in a browser.`);
