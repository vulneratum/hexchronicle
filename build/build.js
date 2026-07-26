#!/usr/bin/env node
/*
 * HexChronicle build — the repo's data files compiled into the published site.
 *
 *   data files ─▶ build.js ─▶ docs/  (data → build → view)
 *
 * The site is ONE CONTINUOUS MAP, not a plate at a time, so the build emits the
 * static equivalents of the editor server's two read endpoints:
 *
 *   docs/world/atlas.json         the whole map's summary — every 36-mile hex,
 *                                 its lattice position, and the theme registry
 *   docs/world/plate-NNNN.json    one plate's interior, fetched on demand as it
 *                                 scrolls into view (the editor's /detail)
 *
 * There is no server: Cloudflare Pages serves these as files, and the page
 * fetches only the plates a visitor actually looks at. That culling matters more
 * here than in the editor — a visitor may have the whole continent in front of
 * them — so the up-front payload is O(plates), never O(plates × 157).
 *
 * Visibility (README §4): only `public` content is compiled in. `gm-only` hex
 * content is dropped here at build time and never reaches the browser.
 *
 * SEAM OWNERSHIP: a plate is 12 subhexes across, so its rim runs through subhex
 * CENTRES and 30 of its positions are also positions on a neighbour. The lower
 * plate id owns them, and every plate's terrain, hex content and line paths are
 * resolved through the owner — the same rule the editor applies, so the site and
 * the editor can never disagree about a hex.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const HexGeo = require("../shared/geometry.js");

const ROOT = path.resolve(__dirname, "..");
const P = (...p) => path.join(ROOT, ...p);

// Custom domain for GitHub Pages. Emitted as docs/CNAME on every build so a
// rebuild never drops it (README §9). Change here if the domain ever changes.
const CUSTOM_DOMAIN = "hexchronicle.com";

function readYaml(file) { return yaml.load(fs.readFileSync(file, "utf8")); }
function die(msg) { console.error("build: ERROR — " + msg); process.exit(1); }

/* ---------- registries + geometry ---------- */
const theme = readYaml(P("theme", "terrain.yaml"));
const registry = { terrain: theme.types || {}, features: theme.features || {}, lines: theme.lines || {} };

const geo = HexGeo.buildPlateHexes();
const N = geo.length;
const validSub = new Set(geo.map(h => h.sub));

/* ---------- every plate, and the lattice they sit on ---------- */
const plateIds = fs.readdirSync(P("plates"))
  .map(f => /^(\d{4})\.ya?ml$/i.exec(f)).filter(Boolean).map(m => m[1]).sort();
if (!plateIds.length) die("no plates found in plates/");

const docs = new Map(plateIds.map(id => [id, readYaml(P("plates", id + ".yaml"))]));
for (const [id, doc] of docs) if (doc.id !== id) die(`plates/${id}.yaml has id "${doc.id}"`);

/*
 * Plates declare neighbours by id, not by position, so the world lattice is
 * derived: walk the declared graph from the LOWEST id, which sits at (0,0) and
 * never moves. The frame is therefore stable for the whole site.
 */
const ORIGIN = plateIds[0];
const coord = { [ORIGIN]: [0, 0] };
const queue = [ORIGIN];
while (queue.length) {
  const id = queue.shift();
  const [q, r] = coord[id];
  for (const [d, [dq, dr]] of Object.entries(HexGeo.PLATE_DIR)) {
    const nid = (docs.get(id).neighbors || {})[d];
    if (!nid || !docs.has(nid) || coord[nid]) continue;
    coord[nid] = [q + dq, r + dr];
    queue.push(nid);
  }
}
const placed = plateIds.filter(id => coord[id]);
const orphans = plateIds.filter(id => !coord[id]);
const own = HexGeo.plateOwnership(coord);

/* ---------- per-hex content files, honouring visibility ---------- */
const hexDir = P("hexes");
const hexFiles = fs.existsSync(hexDir)
  ? new Set(fs.readdirSync(hexDir).filter(f => /\.ya?ml$/i.test(f)).map(f => f.replace(/\.ya?ml$/i, "")))
  : new Set();

let publicCount = 0, gmDropped = 0, borrowedTotal = 0;

/*
 * One plate's interior, keyed by ITS subhex numbers but read through the owner:
 * a borrowed seam position carries the owner's terrain, the owner's hex file and
 * the owner's address, never a second private copy under this plate's number.
 */
function plateDetail(id) {
  const doc = docs.get(id);

  const terrain = {};
  for (const h of geo) {
    const o = own.ownerOf(id, h.sub);
    const src = docs.get(o.plateId) || doc;
    const type = (src.terrain || {})[o.sub] || src.default_terrain;
    if (!registry.terrain[type]) die(`terrain type "${type}" (subhex ${o.plateId}-${o.sub}) is not in theme/terrain.yaml`);
    terrain[h.sub] = type;
    if (o.plateId !== id) borrowedTotal++;
  }

  const hexes = {};
  for (const h of geo) {
    const o = own.ownerOf(id, h.sub);
    const address = o.plateId + "-" + o.sub;
    if (!hexFiles.has(address)) continue;
    const hd = readYaml(path.join(hexDir, address + ".yaml")) || {};
    if (hd.address && hd.address !== address) die(`hexes/${address}.yaml: address "${hd.address}" does not match its file name`);
    if ((hd.visibility || "public") === "gm-only") { gmDropped++; continue; }

    const entry = { address };
    if (hd.name) entry.name = String(hd.name);
    if (hd.feature && hd.feature.type) {
      if (!registry.features[hd.feature.type]) die(`hexes/${address}.yaml: feature type "${hd.feature.type}" not in theme/terrain.yaml`);
      entry.feature = { type: hd.feature.type, name: hd.feature.name || null };
    }
    if (hd.local_memory) entry.local_memory = String(hd.local_memory).trim();
    if (Array.isArray(hd.chronicle)) {
      const c = hd.chronicle
        .filter(x => (x.visibility || "public") !== "gm-only")
        .map(x => ({ date: x.date || "", text: x.text || "" }));
      if (c.length) entry.chronicle = c;
    }
    hexes[h.sub] = entry;
    publicCount++;
  }

  /*
   * A line's path uses ITS plate's subhex numbers, with "PPPP-NNN" for a hex on
   * another plate (README §2). Entries are canonicalised to the OWNER's address
   * so that two plates' pieces of one road name the same place — which is what
   * lets the renderer's graph join them across the seam.
   */
  const lines = (doc.lines || []).map((ln, i) => {
    const p = [];
    for (const entry of (ln.path || []).map(String)) {
      const a = HexGeo.parseAddr(entry);
      if (!a) die(`plate ${id} line #${i + 1} (${ln.type}) references "${entry}", not a subhex address`);
      if (!validSub.has(a.sub)) die(`plate ${id} line #${i + 1} (${ln.type}) references subhex "${entry}", out of range`);
      const o = own.ownerOf(a.plate || id, a.sub);
      p.push(o.plateId === id ? o.sub : `${o.plateId}-${o.sub}`);
    }
    return { type: ln.type, path: p };
  });

  return {
    id,
    name: doc.name || null,
    title: doc.title || doc.name || null,
    canton: doc.canton != null ? doc.canton : null,
    realm: doc.realm != null ? doc.realm : null,
    summary: doc.summary ? String(doc.summary).trim() : "",
    continent_hex: doc.continent_hex != null ? doc.continent_hex : null,
    scale_label: doc.scale_label || null,
    default_terrain: doc.default_terrain,
    terrain, lines, hexes,
    borrowed: Object.fromEntries(own.borrowedSubs(id).map(sub => [sub, own.addressOf(id, sub)])),
  };
}

/* ---------- emit ---------- */
const DOCS = P("docs");
fs.mkdirSync(path.join(DOCS, "world"), { recursive: true });

const details = new Map(placed.map(id => [id, plateDetail(id)]));

/* the summary: everything the map needs before a single plate is fetched */
const atlas = {
  generatedFrom: "repo data files (README §4)",
  origin: ORIGIN,
  registry,
  plates: placed.map(id => {
    const d = details.get(id);
    return {
      id, coord: coord[id],
      name: d.name, title: d.title, realm: d.realm, canton: d.canton,
      continent_hex: d.continent_hex, scale_label: d.scale_label,
      default_terrain: d.default_terrain, summary: d.summary,
    };
  }),
};
fs.writeFileSync(path.join(DOCS, "world", "atlas.json"), JSON.stringify(atlas, null, 2));
for (const [id, d] of details) {
  fs.writeFileSync(path.join(DOCS, "world", `plate-${id}.json`), JSON.stringify(d, null, 2));
}

/* ---------- the page itself ---------- */
const template = fs.readFileSync(P("build", "template.html"), "utf8");
/*
 * LF, always. The template is CRLF on this machine and the inlined sources are
 * LF, which produced a mixed-ending file: byte-stable per machine, but a diff
 * for anyone whose git normalises differently. docs/ is generated output, so it
 * is normalised here rather than left to .gitattributes to paper over.
 */
const html = template
  .replace("/*__GEOMETRY_JS__*/", () => fs.readFileSync(P("shared", "geometry.js"), "utf8"))
  .replace("/*__PLATEDRAW_JS__*/", () => fs.readFileSync(P("shared", "plate-draw.js"), "utf8"))
  .replace("/*__RENDERER_JS__*/", () => fs.readFileSync(P("build", "renderer.js"), "utf8"))
  .replace(/\r\n/g, "\n");

fs.writeFileSync(path.join(DOCS, "index.html"), html);

/*
 * Fonts, copied from assets/ so the page can serve them same-origin. Committed
 * binaries rather than a build-time download: the build must work offline and
 * must not depend on a third party still serving the same bytes.
 */
const FONT_SRC = P("assets", "fonts");
const FONT_OUT = path.join(DOCS, "fonts");
fs.mkdirSync(FONT_OUT, { recursive: true });
const fontFiles = fs.readdirSync(FONT_SRC).filter(f => f.endsWith(".woff2"));
for (const f of fontFiles) fs.copyFileSync(path.join(FONT_SRC, f), path.join(FONT_OUT, f));
for (const f of fs.readdirSync(FONT_OUT)) {
  if (!fontFiles.includes(f)) fs.unlinkSync(path.join(FONT_OUT, f));
}
// every @font-face in the page must point at a file that is actually here
for (const m of html.matchAll(/url\(fonts\/([^)]+)\)/g)) {
  if (!fontFiles.includes(m[1])) die(`the page references fonts/${m[1]}, which is not in assets/fonts/`);
}

/*
 * Cache policy for Cloudflare Pages. The fonts are content-addressed by name
 * and will never change without a rename, so they are immutable for a year.
 * index.html must always be revalidated or a rebuild would not reach anyone.
 * The world data sits in between: cheap to revalidate, and a stale plate for a
 * few minutes is harmless.
 */
fs.writeFileSync(path.join(DOCS, "_headers"), [
  "/fonts/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
  "/world/*",
  "  Cache-Control: public, max-age=300, must-revalidate",
  "",
  "/index.html",
  "  Cache-Control: public, max-age=0, must-revalidate",
  "",
  "/",
  "  Cache-Control: public, max-age=0, must-revalidate",
  "",
].join("\n"));

// CNAME tells GitHub Pages the custom domain; regenerated so it always persists.
fs.writeFileSync(path.join(DOCS, "CNAME"), CUSTOM_DOMAIN + "\n");
// .nojekyll: serve files as-is (skip Jekyll processing) — belt-and-suspenders.
fs.writeFileSync(path.join(DOCS, ".nojekyll"), "");

/* stale plate files from a previous build, for a plate since removed */
for (const f of fs.readdirSync(path.join(DOCS, "world"))) {
  const m = /^plate-(\d{4})\.json$/.exec(f);
  if (m && !details.has(m[1])) fs.unlinkSync(path.join(DOCS, "world", f));
}

/* ---------- the published site carries NO editor chrome ---------- *
 *
 * The real guarantee is placement: everything that exists only to support
 * editing lives in editor/, and the shared renderer has no concept of it — no
 * flag to set wrong. This is the belt to that pair of braces. It scans what was
 * actually emitted, so if editing UI ever drifts into shared/ or into the
 * compiled data, the build fails here rather than shipping it.
 *
 * `empty` — the list of lattice positions you could put a new plate in — is
 * never compiled into the atlas summary at all, so the site could not draw an
 * add marker even if something asked it to.
 */
const NO_EDITOR_CHROME = [
  "ADD 36-MI",        // the marker's label
  "addmark",          // its class
  "slotContent", "ensureSlot", "slotAt", "slotIndex", "updateSlots", "setSlots", "drawSlot",
  "EDITOR_TOKEN",     // the editor's write credential
  // The site must make NO third-party request: every font is served from here.
  // A stray Google Fonts link would reintroduce a render-blocking foreign
  // stylesheet and hand every visitor's IP to a host unrelated to the map.
  "fonts.googleapis.com", "fonts.gstatic.com",
];
const emitted = [path.join(DOCS, "index.html"), path.join(DOCS, "world", "atlas.json")]
  .concat([...details.keys()].map(id => path.join(DOCS, "world", `plate-${id}.json`)));
const leaks = [];
for (const file of emitted) {
  const text = fs.readFileSync(file, "utf8");
  for (const token of NO_EDITOR_CHROME) {
    if (text.includes(token)) leaks.push(`${path.relative(ROOT, file)} contains "${token}"`);
  }
}
if (leaks.length) die(`editor-only code reached the published site:\n  ${leaks.join("\n  ")}`);

/* ---------- report ---------- */
console.log(`build: ${placed.length} plate(s) · ${N} subhexes each`);
console.log(`build:   ${placed.map(id => `${id}${details.get(id).name ? " (" + details.get(id).name + ")" : ""}`).join(", ")}`);
console.log(`build:   ${borrowedTotal} boundary subhex(es) resolved to their owning plate`);
console.log(`build:   ${publicCount} public hex records compiled` + (gmDropped ? `, ${gmDropped} gm-only dropped` : ""));
if (orphans.length) console.log(`build:   WARNING ${orphans.length} plate(s) not linked to the map: ${orphans.join(", ")}`);
console.log(`build:   wrote docs/index.html, docs/world/atlas.json and ${details.size} plate file(s)`);
console.log(`build: done.`);
