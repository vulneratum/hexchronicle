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

/* ---- structured hex-file writers (Phase 5: per-subhex metadata) ---- */
/*
 * This is the case the eemeli Document helpers above were kept for. A plate's
 * terrain grid is a machine-owned block, so we rewrite it surgically; a hex file
 * is the opposite — hand-written prose with comments, folded scalars, and a
 * chronicle owned by the living-world agent. So: parse the document, mutate only
 * the nodes named in `fields`, serialise. Everything else is carried through.
 *
 * `fields` holds MAP fields only — the caller has already put its key set
 * through guard.assertHexFieldsAllowed(), so chronicle/local_memory cannot
 * reach here. A null value DELETES the key.
 */
function updateHexFields(absPath, fields) {
  const raw = fs.readFileSync(absPath, "utf8");
  const doc = loadDoc(absPath);
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) { doc.delete(key); continue; }
    if (key === "feature") {
      let node = doc.get("feature", true);
      if (!node || typeof node.set !== "function") { doc.set("feature", {}); node = doc.get("feature", true); }
      setValue(node, "type", value.type, false);
      if (value.name == null) node.delete("name");
      else setValue(node, "name", value.name, true);
      continue;
    }
    setValue(doc, key, value, key === "name" || key === "address");
  }
  fs.writeFileSync(absPath, matchOriginalFormatting(doc.toString({ lineWidth: 0, flowCollectionPadding: false }), raw));
}

/*
 * Undo the two cosmetic things an eemeli round-trip does to lines it was not
 * asked to touch (the module header calls both out): it emits LF regardless of
 * the file's line endings, and it collapses the whitespace before an inline
 * comment to a single space — turning
 *
 *   visibility: public          # public | gm-only (README §4)
 * into
 *   visibility: public # public | gm-only (README §4)
 *
 * Neither is a content change, but both show up as a diff on every line of a
 * hand-written file, which is exactly what README §6 asks us not to do.
 */
function matchOriginalFormatting(out, raw) {
  const INLINE = /^(\s*)([\w-]+:)([^#\n]*?)(\s+)(#.*)$/;
  const padByKey = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const m = INLINE.exec(line);
    if (m) padByKey.set(m[1] + m[2], m[4]);
  }
  let text = out.split("\n").map(line => {
    const m = INLINE.exec(line);
    if (!m) return line;
    const pad = padByKey.get(m[1] + m[2]);
    return pad ? m[1] + m[2] + m[3] + pad + m[5] : line;
  }).join("\n");
  if (raw.includes("\r\n")) text = text.replace(/\r?\n/g, "\r\n");
  return text;
}

/*
 * Change a scalar IN PLACE when the key already exists. Reusing the node keeps
 * its inline comment and quoting style — `visibility: public   # public |
 * gm-only (README §4)` survives a visibility change, where doc.set() would
 * replace the node and drop the comment with it.
 */
function setValue(map, key, value, quote) {
  const node = map.get(key, true);
  if (node && typeof node === "object" && "value" in node) { node.value = value; return; }
  map.set(key, quote ? quotedKey(value) : value);
}

/*
 * A hex file that does not exist yet, rendered from a template mirroring the
 * hand-written ones (hexes/0001-104.yaml) so the two are indistinguishable.
 * Written with `wx` so it can never clobber, even if something raced the
 * guard.assertCreatable() check. No chronicle, no local_memory — a new hex
 * carries map data only; the living-world agent adds the story.
 */
function writeNewHex(absPath, spec) {
  const q = s => `"${String(s).replace(/"/g, '\\"')}"`;
  const f = spec.fields || {};
  const L = [];
  L.push(`# Subhex ${spec.address} — content file (README §4). Terrain comes from the`);
  L.push(`# plate grid; this file carries features, names, and chronicle.`);
  L.push(``);
  L.push(`address: ${q(spec.address)}`);
  L.push(`visibility: ${f.visibility || "public"}          # public | gm-only (README §4)`);
  if (f.name) L.push(`name: ${q(f.name)}`);
  if (f.feature && f.feature.type) {
    L.push(`feature:`);
    L.push(`  type: ${f.feature.type}`);
    if (f.feature.name) L.push(`  name: ${q(f.feature.name)}`);
  }
  L.push(``);
  fs.writeFileSync(absPath, L.join(spec.eol || "\n"), { flag: "wx" });
}

/* ---- surgical plate-meta writer ---- */
/*
 * The plate's descriptive top-level fields: name, title, canton, realm,
 * summary, continent_hex, scale_label. Same surgical strategy as the terrain
 * grid, and for the same reason — everything else in the file (the header
 * comments, the neighbours block, the terrain grid, the lines) must come out
 * byte-for-byte identical, and a full round-trip cannot promise that.
 *
 * A scalar is rewritten in place, keeping its inline comment. `summary` is a
 * folded block, so its indented body is replaced wholesale. A field that is not
 * in the file yet is inserted just above `default_terrain:`, which is where the
 * descriptive block ends in every plate file the generator writes.
 *
 * The caller has already put the key set through guard.assertPlateMetaAllowed(),
 * so id / terrain / lines / neighbors cannot reach here.
 */
function updatePlateMeta(absPath, fields) {
  const raw = fs.readFileSync(absPath, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const q = s => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const QUOTED = new Set(["name", "title", "scale_label"]);

  const findKey = key => lines.findIndex(l => new RegExp(`^${key}:(\\s|$)`).test(l));

  for (const [key, value] of Object.entries(fields)) {
    const at = findKey(key);

    if (key === "summary") {
      const body = String(value == null ? "" : value).trim();
      const block = [">"].concat(body ? body.split(/\n/).map(s => "  " + s.trim()) : ["  "]);
      if (at === -1) {
        insertBefore(lines, "default_terrain:", ["summary: " + block[0]].concat(block.slice(1)));
      } else {
        let end = at + 1;
        while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
        lines.splice(at, end - at, "summary: " + block[0], ...block.slice(1));
      }
      continue;
    }

    // a null or empty value removes an optional key rather than writing ""
    const drop = value == null || value === "";
    if (at === -1) {
      if (drop) continue;
      const text = `${key}: ${QUOTED.has(key) ? q(value) : value}`;
      insertBefore(lines, "default_terrain:", [text]);
      continue;
    }
    if (drop) { lines.splice(at, 1); continue; }
    const m = /^([\w-]+:\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^#]*?)(\s*#.*)?$/.exec(lines[at]);
    const tail = (m && m[2]) || "";
    lines[at] = `${key}: ${QUOTED.has(key) ? q(value) : value}${tail}`;
  }

  fs.writeFileSync(absPath, lines.join(nl));
}

/* insert `block` immediately above the first line starting with `anchor` */
function insertBefore(lines, anchor, block) {
  let at = lines.findIndex(l => l.startsWith(anchor));
  if (at === -1) at = lines.length;
  // keep the blank line that separates the descriptive block from what follows
  while (at > 0 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, ...block);
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
  updateHexFields, writeNewHex, updatePlateMeta,
};
