#!/usr/bin/env node
/*
 * HexChronicle editor server (README §6) — `npm run editor`.
 *
 * Fully local: binds 127.0.0.1 ONLY, serves the editor page + shared modules,
 * and exposes a NARROW, semantic API. There is no generic file-write endpoint;
 * every write goes through the scope guard (editor/guard.js). A per-run token
 * (injected into the page) is required on mutating calls, so another local page
 * can't drive the editor.
 *
 * Phase 1: build the plate model + terrain paint Save.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const jsyaml = require("js-yaml");

const guard = require("./guard.js");
const yamlIo = require("./yaml-io.js");
const HexGeo = require("../shared/geometry.js");

const ROOT = guard.REPO_ROOT;
const PORT = Number(process.env.EDITOR_PORT) || 4137;
const HOST = "127.0.0.1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const R = (...p) => path.join(ROOT, ...p);

/* ---------- read-only model builder (writes never happen here) ---------- */
function readYaml(rel) { return jsyaml.load(fs.readFileSync(R(rel), "utf8")); }

function buildModel(plateId) {
  const theme = readYaml("theme/terrain.yaml");
  const registry = { terrain: theme.types || {}, features: theme.features || {} };
  const plate = readYaml(`plates/${plateId}.yaml`);

  const geo = HexGeo.buildPlateHexes();
  const validSub = new Set(geo.map(h => h.sub));
  const defaultTerrain = plate.default_terrain;

  const terrainByNum = {};
  for (const h of geo) terrainByNum[h.sub] = defaultTerrain;
  for (const [sub, type] of Object.entries(plate.terrain || {})) {
    if (validSub.has(sub)) terrainByNum[sub] = type;
  }

  // hex content: features ONLY (the editor never loads/surfaces story fields)
  const hexContent = {};
  const hexDir = R("hexes");
  if (fs.existsSync(hexDir)) {
    for (const f of fs.readdirSync(hexDir).filter(f => /\.ya?ml$/i.test(f))) {
      const m = /^(\d{4})-(\d{3})\.ya?ml$/i.exec(f);
      if (!m || m[1] !== plateId) continue;
      const doc = jsyaml.load(fs.readFileSync(path.join(hexDir, f), "utf8")) || {};
      if (doc.feature && doc.feature.type) {
        hexContent[m[2]] = { feature: { type: doc.feature.type, name: doc.feature.name || null } };
      }
    }
  }

  return {
    plate: {
      id: plate.id, continent_hex: plate.continent_hex, name: plate.name,
      title: plate.title || plate.name, canton: plate.canton, realm: plate.realm,
      scale_label: plate.scale_label, default_terrain: defaultTerrain,
      neighbors: plate.neighbors || {},
    },
    registry, terrainByNum, hexContent, lines: plate.lines || [],
  };
}

/* ---------- write op: terrain (Phase 1), guarded ---------- */
function savePlateTerrain(plateId, body) {
  const model = buildModel(plateId);      // for validation (types, subs, default)
  const validSub = new Set(HexGeo.buildPlateHexes().map(h => h.sub));
  const types = model.registry.terrain;

  const defaultTerrain = body.default_terrain || model.plate.default_terrain;
  if (!types[defaultTerrain]) throw new HttpError(400, `unknown default_terrain "${defaultTerrain}"`);

  const overrides = {};
  for (const [sub, type] of Object.entries(body.terrain || {})) {
    if (!validSub.has(sub)) throw new HttpError(400, `subhex "${sub}" out of range`);
    if (!types[type]) throw new HttpError(400, `unknown terrain type "${type}" (subhex ${sub})`);
    if (type === defaultTerrain) continue;     // keep the grid sparse
    overrides[sub] = type;
  }

  const abs = guard.assertInScope(`plates/${plateId}.yaml`);   // structural boundary
  yamlIo.writePlateTerrain(abs, { defaultTerrain, overrides });
  return { ok: true, overrides: Object.keys(overrides).length };
}

/* ---------- tiny http plumbing ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, type) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type || "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}

const STATIC = {
  "/editor.js": ["editor/editor.js", "text/javascript"],
  "/editor.css": ["editor/editor.css", "text/css"],
  "/shared/geometry.js": ["shared/geometry.js", "text/javascript"],
  "/shared/plate-draw.js": ["shared/plate-draw.js", "text/javascript"],
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on("end", () => resolve(d)); req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = u.pathname;

    // static
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      let html = fs.readFileSync(R("editor/editor.html"), "utf8").replace("__EDITOR_TOKEN__", TOKEN);
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && STATIC[p]) {
      const [rel, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(R(rel)), type);
    }

    // API: model
    if (req.method === "GET" && p === "/api/model") {
      const id = u.searchParams.get("plate") || "0001";
      return send(res, 200, buildModel(id));
    }

    // API: mutating — require the token
    if (p.startsWith("/api/") && req.method !== "GET") {
      if (req.headers["x-editor-token"] !== TOKEN) return send(res, 403, { error: "bad or missing editor token" });
    }

    // API: PUT /api/plate/:id/terrain
    let m;
    if (req.method === "PUT" && (m = /^\/api\/plate\/(\d{4})\/terrain$/.exec(p))) {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, savePlateTerrain(m[1], body));
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e.scopeViolation) return send(res, 403, { error: e.message, scopeViolation: true });
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error("editor: 500", e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`HexChronicle editor → ${url}`);
  console.log(`  scope: writes limited to ${guard.ALLOWED_ROOTS.join(", ")}/  (README §6)`);
  console.log(`  bound to ${HOST} only; press Ctrl+C to stop.`);
  if (!process.env.EDITOR_NO_OPEN) {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { execFile(cmd[0], cmd[1]); } catch { /* opening is best-effort */ }
  }
});
