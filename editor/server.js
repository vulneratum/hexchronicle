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
const plateGen = require("./plate-gen.js");
const HexGeo = require("../shared/geometry.js");

const ROOT = guard.REPO_ROOT;
const PORT = Number(process.env.EDITOR_PORT) || 4137;
const HOST = "127.0.0.1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const R = (...p) => path.join(ROOT, ...p);

/* ---------- read-only model builder (writes never happen here) ---------- */
function readYaml(rel) { return jsyaml.load(fs.readFileSync(R(rel), "utf8")); }

// hex content: features ONLY (the editor never loads/surfaces story fields)
function readFeatures(plateId) {
  const hexContent = {};
  const hexDir = R("hexes");
  if (!fs.existsSync(hexDir)) return hexContent;
  for (const f of fs.readdirSync(hexDir).filter(f => /\.ya?ml$/i.test(f))) {
    const m = /^(\d{4})-(\d{3})\.ya?ml$/i.exec(f);
    if (!m || m[1] !== plateId) continue;
    const doc = jsyaml.load(fs.readFileSync(path.join(hexDir, f), "utf8")) || {};
    if (doc.feature && doc.feature.type) {
      hexContent[m[2]] = { feature: { type: doc.feature.type, name: doc.feature.name || null } };
    }
  }
  return hexContent;
}

function buildModel(plateId) {
  const theme = readYaml("theme/terrain.yaml");
  const registry = { terrain: theme.types || {}, features: theme.features || {}, lines: theme.lines || {} };
  const plate = readYaml(`plates/${plateId}.yaml`);

  const geo = HexGeo.buildPlateHexes();
  const validSub = new Set(geo.map(h => h.sub));
  const defaultTerrain = plate.default_terrain;

  const terrainByNum = {};
  for (const h of geo) terrainByNum[h.sub] = defaultTerrain;
  for (const [sub, type] of Object.entries(plate.terrain || {})) {
    if (validSub.has(sub)) terrainByNum[sub] = type;
  }

  const hexContent = readFeatures(plateId);

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

/* ---------- write op: line features (Phase 2), guarded ---------- */
function savePlateLines(plateId, body) {
  const model = buildModel(plateId);
  const validSub = new Set(HexGeo.buildPlateHexes().map(h => h.sub));
  const lineTypes = model.registry.lines;

  const linesArr = [];
  for (const ln of (body.lines || [])) {
    if (!lineTypes[ln.type]) throw new HttpError(400, `unknown line type "${ln.type}"`);
    const path = (ln.path || []).map(String);
    for (const sub of path) if (!validSub.has(sub)) throw new HttpError(400, `line references subhex "${sub}" out of range`);
    if (path.length < 2) throw new HttpError(400, `a ${ln.type} needs at least 2 hexes`);
    linesArr.push({ type: ln.type, path });
  }

  const abs = guard.assertInScope(`plates/${plateId}.yaml`);   // structural boundary
  yamlIo.writePlateLines(abs, linesArr);
  return { ok: true, lines: linesArr.length };
}


/* ---------- plate directory + lattice ---------- */
/*
 * Plates declare their neighbours by id, not by position, so there is no world
 * coordinate system on disk. We derive one on demand: walk the declared
 * neighbour graph from any plate, assigning axial coordinates. The plate
 * lattice uses the SAME axial convention as subhexes (shared/geometry.js), so
 * `e` is [1,0], `se` is [0,1], and so on.
 *
 * This is what lets a new plate discover EVERY existing plate it touches, not
 * just the one whose chip was clicked — a plate dropped into a pocket blends
 * against all its neighbours and back-links all of them.
 */
const PLATE_DIR = { e: [1, 0], se: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [0, -1], ne: [1, -1] };
const OPPOSITE = plateGen.OPPOSITE;

function plateIds() {
  const dir = R("plates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(f => /^(\d{4})\.ya?ml$/i.exec(f))
    .filter(Boolean).map(m => m[1]).sort();
}

function listPlates() {
  return plateIds().map(id => {
    const p = readYaml(`plates/${id}.yaml`);
    return { id: p.id || id, name: p.name || null, realm: p.realm || null, neighbors: p.neighbors || {} };
  });
}

function buildLattice(originId) {
  const plates = new Map(listPlates().map(p => [p.id, p]));
  if (!plates.has(originId)) throw new HttpError(404, `no such plate ${originId}`);

  const coord = new Map([[originId, [0, 0]]]);
  const atCoord = new Map([["0,0", originId]]);
  const queue = [originId];
  const conflicts = [];

  while (queue.length) {
    const id = queue.shift();
    const [q, r] = coord.get(id);
    for (const [dir, [dq, dr]] of Object.entries(PLATE_DIR)) {
      const nid = (plates.get(id).neighbors || {})[dir];
      if (!nid || !plates.has(nid)) continue;
      const key = (q + dq) + "," + (r + dr);
      if (coord.has(nid)) {
        if (coord.get(nid).join(",") !== key) conflicts.push(`${id}.${dir} -> ${nid}`);
        continue;
      }
      coord.set(nid, [q + dq, r + dr]);
      atCoord.set(key, nid);
      queue.push(nid);
    }
  }
  return { plates, coord, atCoord, conflicts };
}

function nextPlateId() {
  const ids = plateIds().map(Number);
  return String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0");
}

function detectEol() {
  for (const id of plateIds()) {
    const raw = fs.readFileSync(R(`plates/${id}.yaml`), "utf8");
    return raw.includes("\r\n") ? "\r\n" : "\n";
  }
  return "\n";
}


/*
 * The whole map, laid out around `originId` (which sits at 0,0). The editor
 * draws every plate at its lattice position so the atlas stays visible while
 * you work, rather than showing one plate in isolation.
 *
 * `empty` lists every lattice position adjacent to an existing plate that has
 * no plate yet — the slots the editor offers to fill. Each carries a `from`
 * plate and direction, which is all createPlate needs.
 */
function buildAtlas(originId) {
  const { plates, coord, atCoord, conflicts } = buildLattice(originId);

  const out = [];
  for (const [id] of plates) {
    if (!coord.has(id)) continue;                 // not reachable from the origin
    const doc = readYaml(`plates/${id}.yaml`);
    // Summary only — the heavy per-hex terrain/lines/features are fetched per
    // plate on demand via /api/plate/:id/detail, so the atlas payload stays
    // O(plates) rather than O(plates × 157) as the map grows.
    out.push({
      id,
      name: doc.name || null,
      realm: doc.realm || null,
      continent_hex: doc.continent_hex != null ? doc.continent_hex : null,
      coord: coord.get(id),
      default_terrain: doc.default_terrain,
    });
  }

  const empty = [], seen = new Set(), dangling = [];
  for (const [id, [q, r]] of coord) {
    for (const [dir, [dq, dr]] of Object.entries(PLATE_DIR)) {
      const key = (q + dq) + "," + (r + dr);
      if (atCoord.has(key) || seen.has(key)) continue;
      // A plate can name a neighbour whose file is gone (hand-edited YAML).
      // The position looks free but createPlate would refuse it, so don't
      // offer it as a slot — surface it as a data problem instead.
      const declared = (plates.get(id).neighbors || {})[dir];
      if (declared) { dangling.push(`${id}.${dir} -> ${declared} (missing)`); continue; }
      seen.add(key);
      empty.push({ coord: [q + dq, r + dr], from: id, dir });
    }
  }

  const orphans = plateIds().filter(id => !coord.has(id));
  return { origin: originId, plates: out, empty, conflicts, orphans, dangling, profiles: plateGen.PROFILES };
}

/*
 * One plate's full interior — the heavy data the atlas summary omits. Fetched
 * on demand when a plate crosses into detail LOD and is on screen, then cached
 * client-side. Read-only.
 */
function plateDetail(id) {
  if (!fs.existsSync(R(`plates/${id}.yaml`))) throw new HttpError(404, `no such plate ${id}`);
  const doc = readYaml(`plates/${id}.yaml`);
  return {
    id,
    default_terrain: doc.default_terrain,
    terrain: doc.terrain || {},
    lines: doc.lines || [],
    features: readFeatures(id),
  };
}

/* ---------- write op: create a plate (Phase 3), guarded ---------- */
/*
 * Creates ONE new file. The only thing it writes to an existing plate is a
 * single line in that plate's `neighbors:` block — never a subhex, never a
 * line feature, never prose. Neighbouring terrain is read as a boundary
 * condition for generation and is never written back.
 */
function planPlate(body) {
  const fromId = String(body.from || "");
  const dir = String(body.dir || "");
  if (!PLATE_DIR[dir]) throw new HttpError(400, `unknown direction "${dir}"`);

  const { plates, coord, atCoord } = buildLattice(fromId);
  const from = plates.get(fromId);
  if ((from.neighbors || {})[dir]) throw new HttpError(409, `plate ${fromId} already has a ${dir} neighbour (${from.neighbors[dir]})`);

  const [fq, fr] = coord.get(fromId);
  const [dq, dr] = PLATE_DIR[dir];
  const pos = [fq + dq, fr + dr];
  if (atCoord.has(pos.join(","))) throw new HttpError(409, `plate ${atCoord.get(pos.join(","))} already occupies that position`);

  // every existing plate adjacent to the new position, in all six directions
  const adjacency = {};
  for (const [d, [ddq, ddr]] of Object.entries(PLATE_DIR)) {
    const nid = atCoord.get((pos[0] + ddq) + "," + (pos[1] + ddr));
    if (nid) adjacency[d] = nid;
  }

  const theme = readYaml("theme/terrain.yaml");
  const hexes = HexGeo.buildPlateHexes();

  // read neighbouring terrain — READ ONLY, purely as a boundary condition
  let edgeSeeds = [];
  if (body.blend !== false) {
    const terrainByDir = {};
    for (const [d, nid] of Object.entries(adjacency)) {
      const np = readYaml(`plates/${nid}.yaml`);
      const full = {};
      for (const h of hexes) full[h.sub] = np.default_terrain;
      for (const [sub, t] of Object.entries(np.terrain || {})) full[sub] = t;
      terrainByDir[d] = full;
    }
    edgeSeeds = plateGen.computeEdgeSeeds(hexes, terrainByDir);
  }

  const id = nextPlateId();
  const seed = body.seed ? String(body.seed) : `${theme.world_seed || "hexchronicle"}:${id}`;
  const profile = body.profile || "lowland";
  if (!plateGen.PROFILES[profile]) throw new HttpError(400, `unknown profile "${profile}"`);

  const rolled = plateGen.generatePlate({ hexes, types: theme.types, profile, seed, edgeSeeds });

  return { id, profile, seed, rolled, edgeSeeds, adjacency, fromId, body, theme };
}

/*
 * Preview: everything planPlate does EXCEPT touching the disk. Lets the editor
 * roll and re-roll a candidate plate before anything is committed.
 */
function previewPlate(body) {
  const plan = planPlate(body);
  return {
    ok: true, preview: true, id: plan.id, profile: plan.profile, seed: plan.seed,
    default_terrain: plan.rolled.defaultTerrain, terrain: plan.rolled.terrain,
    counts: plan.rolled.counts, edge_seeds: plan.edgeSeeds.length, neighbors: plan.adjacency,
  };
}

function createPlate(body) {
  const { id, profile, seed, rolled, edgeSeeds, adjacency, fromId } = planPlate(body);

  const abs = guard.assertCreatable(`plates/${id}.yaml`);   // structural boundary
  yamlIo.writeNewPlate(abs, {
    id,
    continent_hex: body.continent_hex != null ? body.continent_hex : (readYaml(`plates/${fromId}.yaml`).continent_hex || 1),
    name: body.name || `Plate ${id}`,
    canton: body.canton !== undefined ? body.canton : readYaml(`plates/${fromId}.yaml`).canton,
    realm: body.realm !== undefined ? body.realm : readYaml(`plates/${fromId}.yaml`).realm,
    summary: body.summary,
    profile, seed, edgeSeeds: edgeSeeds.length,
    neighbors: adjacency,
    default_terrain: rolled.defaultTerrain,
    terrain: rolled.terrain,
    eol: detectEol(),
  });

  // back-link every adjacent plate: one line each, inside `neighbors:` only
  const linked = [];
  for (const [d, nid] of Object.entries(adjacency)) {
    const nabs = guard.assertInScope(`plates/${nid}.yaml`);
    try { yamlIo.setPlateNeighbor(nabs, OPPOSITE[d], id); linked.push(nid); }
    catch (e) { console.error(`editor: could not back-link ${nid}.${OPPOSITE[d]} -> ${id}: ${e.message}`); }
  }

  return {
    ok: true, id, profile, seed,
    default_terrain: rolled.defaultTerrain,
    overrides: Object.keys(rolled.terrain).length,
    counts: rolled.counts,
    edge_seeds: edgeSeeds.length,
    neighbors: adjacency,
    back_linked: linked,
  };
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

    // API: plate directory
    if (req.method === "GET" && p === "/api/plates") {
      const { conflicts } = buildLattice(plateIds()[0] || "0001");
      return send(res, 200, { plates: listPlates(), profiles: plateGen.PROFILES, conflicts });
    }

    // API: the whole map, positioned around one plate
    if (req.method === "GET" && p === "/api/atlas") {
      const id = u.searchParams.get("origin") || plateIds()[0] || "0001";
      return send(res, 200, buildAtlas(id));
    }

    // API: model
    if (req.method === "GET" && p === "/api/model") {
      const id = u.searchParams.get("plate") || "0001";
      return send(res, 200, buildModel(id));
    }

    // API: one plate's full interior (detail LOD, fetched on demand)
    let dm;
    if (req.method === "GET" && (dm = /^\/api\/plate\/(\d{4})\/detail$/.exec(p))) {
      return send(res, 200, plateDetail(dm[1]));
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
    if (req.method === "PUT" && (m = /^\/api\/plate\/(\d{4})\/lines$/.exec(p))) {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, savePlateLines(m[1], body));
    }
    // API: POST /api/plate/preview — roll a candidate without writing anything
    if (req.method === "POST" && p === "/api/plate/preview") {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, previewPlate(body));
    }
    // API: POST /api/plate — create a new 36-mile hex
    if (req.method === "POST" && p === "/api/plate") {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, createPlate(body));
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
