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

module.exports = { loadDoc, saveDoc, quotedKey, writePlateTerrain };
