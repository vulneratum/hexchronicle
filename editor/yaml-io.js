/*
 * YAML writers for the editor.
 *
 * The terrain grid (plates/*.yaml) is a rigid, machine-owned block, so we edit
 * it SURGICALLY: only the entry lines are rewritten, leaving the header line,
 * its inline comment, the summary, metadata, and the `lines:` block BYTE-FOR-
 * BYTE identical. (A full eemeli round-trip re-folds block scalars and collapses
 * comment alignment on untouched nodes — too much churn for "preserve formatting
 * as much as possible", README §6.)
 *
 * The eemeli `yaml` Document helpers (loadDoc/saveDoc) are kept for the
 * STRUCTURED writes coming in Phase 2 (hex feature/name, theme types), where
 * comment-aware node mutation is the right tool and surgery isn't practical.
 */
"use strict";
const fs = require("fs");
const { parseDocument, Scalar } = require("yaml");

/* ---- eemeli Document helpers (Phase 2) ---- */
function loadDoc(absPath) { return parseDocument(fs.readFileSync(absPath, "utf8")); }
function saveDoc(absPath, doc) { fs.writeFileSync(absPath, doc.toString({ lineWidth: 0, flowCollectionPadding: false })); }
function quotedKey(s) { const k = new Scalar(String(s)); k.type = Scalar.QUOTE_DOUBLE; return k; }

/* ---- surgical terrain-grid writer (Phase 1) ---- */
/*
 * `overrides` is { "NNN": type } for non-default subhexes only. Entries are
 * written sorted by number, one per line, at the existing indentation. Only the
 * `default_terrain:` value and the terrain entry lines change; everything else
 * in the file is preserved exactly.
 */
function writePlateTerrain(absPath, { defaultTerrain, overrides }) {
  const raw = fs.readFileSync(absPath, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  // update default_terrain, keeping any trailing comment
  if (defaultTerrain != null) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(default_terrain:\s*)(\S+)(.*)$/.exec(lines[i]);
      if (m) { lines[i] = m[1] + defaultTerrain + m[3]; break; }
    }
  }

  // locate the `terrain:` block header (its own line + inline comment kept as-is)
  const hi = lines.findIndex(l => /^terrain:\s*(#.*)?$/.test(l));
  if (hi === -1) throw new Error("plate file has no `terrain:` block");

  // the entries are the contiguous run of indented lines right after the header
  let start = hi + 1, end = start;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  const indentMatch = start < end ? /^(\s+)/.exec(lines[start]) : null;
  const indent = indentMatch ? indentMatch[1] : "  ";

  const entries = Object.keys(overrides).sort()
    .map(sub => `${indent}"${sub}": ${overrides[sub]}`);

  lines.splice(start, end - start, ...entries);
  fs.writeFileSync(absPath, lines.join(nl));
}

/* ---- surgical lines-block writer (Phase 2) ---- */
/*
 * Replace the plate's `lines:` block with `linesArr` = [{ type, path:[subs] }].
 * Same surgical strategy as terrain: only the block body is rewritten; the
 * `# Line features` comment above it, the header line, and the rest of the file
 * are preserved. If the file has no lines block yet, one is appended.
 */
function writePlateLines(absPath, linesArr) {
  const raw = fs.readFileSync(absPath, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";

  const body = [];
  for (const ln of linesArr) {
    const p = (ln.path || []).map(s => `"${s}"`).join(", ");
    body.push(`  - type: ${ln.type}`);
    body.push(`    path: [${p}]`);
  }

  const lines = raw.split(/\r?\n/);
  // matches a bare `lines:` header and also `lines: []` (an empty plate),
  // otherwise an empty plate would get a SECOND lines block appended.
  const hi = lines.findIndex(l => /^lines:\s*(\[\s*\])?\s*(#.*)?$/.test(l));
  if (hi === -1) {
    const out = raw.replace(/\s*$/, "") + nl + nl + "lines:" + nl + body.join(nl) + nl;
    fs.writeFileSync(absPath, out);
    return;
  }
  lines[hi] = lines[hi].replace(/^(lines:)\s*\[\s*\]/, "$1");
  let start = hi + 1, end = start;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  lines.splice(start, end - start, ...body);
  fs.writeFileSync(absPath, lines.join(nl));
}

/* ---- new-plate writer (Phase 3) ---- */
/*
 * The surgical writers above edit blocks that already exist; a brand-new plate
 * has no file to operate on, so it is rendered whole from a template that
 * mirrors plates/0001.yaml — same key order, same explanatory comments — and
 * written with the `wx` flag so an existing plate can never be clobbered even
 * if something raced us between the guard check and here.
 *
 * From this point on the file is owned by the surgical writers like any other.
 */
function writeNewPlate(absPath, spec) {
  const q = s => `"${String(s).replace(/"/g, '\\"')}"`;
  const L = [];

  L.push(`# Atlas plate ${spec.id} (README §3, §4). One atlas hex = one page.`);
  L.push(`# Terrain lives here as a compact grid: a default plus per-subhex`);
  L.push(`# overrides keyed by subhex number. Rich per-hex content (features,`);
  L.push(`# names, chronicle) lives in hexes/${spec.id}-NNN.yaml.`);
  L.push(`#`);
  L.push(`# Interior rolled by the editor's plate generator:`);
  L.push(`#   profile ${spec.profile} · seed ${q(spec.seed)}${spec.edgeSeeds ? ` · ${spec.edgeSeeds} border hexes matched to neighbours` : ""}`);
  L.push(`# Re-rolling reproduces this exactly given the same seed, profile, AND`);
  L.push(`# border conditions — the matched-border count above changes as adjoining`);
  L.push(`# plates are added or edited, so a later re-roll may differ near the seams.`);
  L.push(``);
  L.push(`id: ${q(spec.id)}`);
  L.push(`continent_hex: ${spec.continent_hex}            # the 432-mile hex this plate sits within`);
  L.push(`name: ${q(spec.name)}`);
  if (spec.canton) L.push(`canton: ${spec.canton}`);
  if (spec.realm) L.push(`realm: ${spec.realm}`);
  L.push(`title: ${q(spec.title || spec.name)}`);
  L.push(`scale_label: ${q(spec.scale_label || "1 HEX = 3 MILES (1 LEAGUE)")}`);
  L.push(`summary: >`);
  for (const line of (spec.summary || "Newly surveyed ground; no account of it has been written yet.").split("\n")) {
    L.push(`  ${line.trim()}`);
  }
  L.push(``);
  L.push(`# Six adjoining plates (README §3). null = not yet created.`);
  L.push(`neighbors:`);
  for (const d of ["e", "ne", "nw", "w", "sw", "se"]) {
    const v = (spec.neighbors || {})[d];
    L.push(`  ${d}: ${v ? q(v) : "null"}`);
  }
  L.push(``);
  L.push(`default_terrain: ${spec.default_terrain}`);
  L.push(`terrain:                     # subhex number -> terrain type (non-default only)`);
  for (const sub of Object.keys(spec.terrain).sort()) L.push(`  ${q(sub)}: ${spec.terrain[sub]}`);
  L.push(``);
  L.push(`# Line features (README §4): paths crossing subhexes, not per-hex fills.`);
  L.push(`lines:`);
  L.push(``);

  fs.writeFileSync(absPath, L.join(spec.eol || "\n"), { flag: "wx" });
}

/* ---- surgical neighbour back-reference (Phase 3) ---- */
/*
 * Point one key of an existing plate's `neighbors:` block at `plateId`. This is
 * the ONLY thing plate creation writes to an existing file: one line inside the
 * neighbours block, never a subhex, never a line feature, never prose. Refuses
 * if the slot is already taken by a different plate.
 */
function setPlateNeighbor(absPath, dir, plateId) {
  const raw = fs.readFileSync(absPath, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  const hi = lines.findIndex(l => /^neighbors:\s*(#.*)?$/.test(l));
  if (hi === -1) throw new Error("plate file has no `neighbors:` block");

  let end = hi + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;

  for (let i = hi + 1; i < end; i++) {
    const m = new RegExp(`^(\\s+${dir}:\\s*)(\\S+)(.*)$`).exec(lines[i]);
    if (!m) continue;
    const cur = m[2].replace(/^["']|["']$/g, "");
    if (cur !== "null" && cur !== plateId) {
      throw new Error(`neighbour slot "${dir}" already points at plate ${cur}`);
    }
    lines[i] = `${m[1]}"${plateId}"${m[3]}`;
    fs.writeFileSync(absPath, lines.join(nl));
    return;
  }
  throw new Error(`plate file has no "${dir}" key in its neighbors block`);
}

module.exports = {
  loadDoc, saveDoc, quotedKey,
  writePlateTerrain, writePlateLines, writeNewPlate, setPlateNeighbor,
};
