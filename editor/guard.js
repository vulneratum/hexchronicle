/*
 * Scope guard (README §6) — the STRUCTURAL boundary that makes the editor
 * unable to write anything but map data. Every filesystem write in the editor
 * funnels through assertInScope(); every commit path funnels through
 * isAllowedCommitPath(). There is no code path that writes an arbitrary file.
 *
 *   Allowed to write:   plates/**, hexes/** (map fields only), theme/**
 *   NEVER writable:     sessions/, world/, people/, hooks/, realms/, chronicle
 *                       or local_memory fields, README, build/, docs/, .git/
 */
"use strict";
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");

// Directories the editor may write into.
const ALLOWED_ROOTS = ["plates", "hexes", "theme"];

// For hexes/ files (which also hold story fields), only these keys may be
// created or modified. chronicle/local_memory (and anything else) are refused
// — the editor writes the MAP, never the story (README §4).
const HEX_ALLOWED_KEYS = ["address", "visibility", "feature", "terrain", "name"];
const HEX_FORBIDDEN_KEYS = ["chronicle", "local_memory"];

class ScopeError extends Error {
  constructor(msg) { super(msg); this.name = "ScopeError"; this.scopeViolation = true; }
}

function toPosix(p) { return String(p).replace(/\\/g, "/"); }

/*
 * Resolve a repo-relative path and assert it is inside an allowed root.
 * Returns the absolute path, or throws ScopeError. Rejects absolute inputs,
 * any ".." traversal, and anything resolving outside REPO_ROOT.
 */
function assertInScope(relPath) {
  const rel = toPosix(relPath).trim();
  if (!rel) throw new ScopeError("empty path");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new ScopeError(`absolute path refused: ${rel}`);
  const segs = rel.split("/");
  if (segs.some(s => s === ".." || s === "." || s === "")) throw new ScopeError(`illegal path segment: ${rel}`);
  if (!ALLOWED_ROOTS.includes(segs[0])) throw new ScopeError(`path outside map-data scope: ${rel} (allowed roots: ${ALLOWED_ROOTS.join(", ")})`);

  const abs = path.resolve(REPO_ROOT, rel);
  const within = abs === path.join(REPO_ROOT, segs[0]) || abs.startsWith(path.join(REPO_ROOT, segs[0]) + path.sep);
  if (!within) throw new ScopeError(`resolved path escapes scope: ${rel}`);
  return abs;
}

// True if `relPath` is a path the commit step is allowed to stage.
function isAllowedCommitPath(relPath) {
  try { assertInScope(relPath); return true; } catch { return false; }
}

/*
 * Like assertInScope, but additionally refuses to return a path that already
 * exists. Creating a new plate must never overwrite an old one, and "check then
 * write" can race, so callers pair this with the `wx` flag on the actual write.
 * Belt and braces: the check gives a good error message, the flag is the truth.
 */
function assertCreatable(relPath) {
  const abs = assertInScope(relPath);
  if (fs.existsSync(abs)) throw new ScopeError(`refusing to overwrite existing file: ${toPosix(relPath)}`);
  return abs;
}

// Assert an object of YAML fields contains no forbidden (story) keys.
function assertHexFieldsAllowed(keys) {
  for (const k of keys) {
    if (HEX_FORBIDDEN_KEYS.includes(k)) throw new ScopeError(`editor may not write hex field "${k}"`);
    if (!HEX_ALLOWED_KEYS.includes(k)) throw new ScopeError(`unknown hex field "${k}" not in map-data allowlist`);
  }
}

module.exports = {
  REPO_ROOT, ALLOWED_ROOTS, HEX_ALLOWED_KEYS, HEX_FORBIDDEN_KEYS,
  ScopeError, assertInScope, assertCreatable, isAllowedCommitPath, assertHexFieldsAllowed,
};
