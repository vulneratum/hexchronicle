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

/* ---------- seam ownership: one physical hex, one identity ---------- *
 *
 * A plate's boundary runs through subhex CENTRES, so 30 of its 157 positions
 * are also positions on a neighbour (shared/geometry.js). The plate with the
 * lower id owns them; everything below reads and writes THROUGH the owner, so
 * a seam hex has one terrain, one hex file and one address whichever plate you
 * happen to be looking at.
 *
 * Derived from the neighbour graph on demand, never stored.
 */
function ownershipFor(plateId) {
  try {
    return HexGeo.plateOwnership(buildLattice(plateId).coord);
  } catch (e) {
    return HexGeo.plateOwnership({ [plateId]: [0, 0] });     // unplaced: owns itself
  }
}

/* every plate's own terrain grid, filled out and cached for one request */
function terrainReader() {
  const cache = new Map();
  return function terrainOf(plateId, sub) {
    let rec = cache.get(plateId);
    if (!rec) {
      let doc = null;
      try { doc = readYaml(`plates/${plateId}.yaml`); } catch { doc = null; }
      rec = doc ? { def: doc.default_terrain, t: doc.terrain || {} } : null;
      cache.set(plateId, rec);
    }
    return rec ? (rec.t[sub] || rec.def) : null;
  };
}

/*
 * The RESOLVED terrain of every subhex of `plateId`: its own, except on a
 * borrowed position, which takes the owner's. The non-owner's entry for that
 * position is ignored entirely — it is inert data, left on disk for a separate
 * cleanup rather than migrated here.
 */
function resolvedTerrain(plateId, own, read) {
  const out = {};
  for (const h of HexGeo.buildPlateHexes()) {
    const o = own.ownerOf(plateId, h.sub);
    out[h.sub] = read(o.plateId, o.sub) || read(plateId, h.sub);
  }
  return out;
}

/* which subhexes of this plate belong to somebody else, as sub -> "PPPP-SSS" */
function borrowedMap(plateId, own) {
  const out = {};
  for (const sub of own.borrowedSubs(plateId)) out[sub] = own.addressOf(plateId, sub);
  return out;
}

/*
 * One record per EXISTING hex file, keyed by this plate's subhex number but
 * READ FROM THE OWNER's file. Doubles as PlateDraw's `hexContent` (it reads
 * only `feature`), so the extra keys are inert for rendering and exist for the
 * metadata panel.
 *
 * `chronicle` and `local_memory` are surfaced READ-ONLY: they belong to the
 * living-world agent (README §4) and the scope guard refuses to write them.
 * Reading them here lets the editor show you what a hex already carries so you
 * do not have to guess; nothing sends them back.
 */
function readHexRecords(plateId, own) {
  const hexContent = {};
  const hexDir = R("hexes");
  if (!fs.existsSync(hexDir)) return hexContent;
  const present = new Set(fs.readdirSync(hexDir)
    .map(f => /^(\d{4})-(\d{3})\.ya?ml$/i.exec(f)).filter(Boolean).map(m => m[1] + "-" + m[2]));

  for (const h of HexGeo.buildPlateHexes()) {
    const o = own ? own.ownerOf(plateId, h.sub) : { plateId, sub: h.sub };
    const address = o.plateId + "-" + o.sub;
    if (!present.has(address)) continue;
    const f = `${address}.yaml`;
    const doc = jsyaml.load(fs.readFileSync(path.join(hexDir, f), "utf8")) || {};
    hexContent[h.sub] = {
      address,                                  // the OWNER's address, always
      file: `hexes/${f}`,
      name: doc.name || null,
      visibility: doc.visibility || "public",
      feature: (doc.feature && doc.feature.type)
        ? { type: doc.feature.type, name: doc.feature.name || null } : null,
      local_memory: doc.local_memory ? String(doc.local_memory).trim() : null,
      chronicle: Array.isArray(doc.chronicle)
        ? doc.chronicle.map(c => ({ date: c.date || "", text: c.text || "", visibility: c.visibility || "public" })) : [],
    };
  }
  return hexContent;
}

function themeRegistry() {
  const theme = readYaml("theme/terrain.yaml");
  return { terrain: theme.types || {}, features: theme.features || {}, lines: theme.lines || {} };
}

/* ---------- write op: terrain (Phase 1), guarded ---------- */
function savePlateTerrain(plateId, body) {
  if (!fs.existsSync(R(`plates/${plateId}.yaml`))) throw new HttpError(404, `no such plate ${plateId}`);
  const plate = readYaml(`plates/${plateId}.yaml`);
  const validSub = new Set(HexGeo.buildPlateHexes().map(h => h.sub));
  const types = themeRegistry().terrain;

  const defaultTerrain = body.default_terrain || plate.default_terrain;
  if (!types[defaultTerrain]) throw new HttpError(400, `unknown default_terrain "${defaultTerrain}"`);

  /*
   * A plate writes only the positions it OWNS. The 30 seam positions it merely
   * borrows belong to the lower-numbered neighbour, and the editor routes those
   * edits there; anything arriving here for one is dropped rather than written
   * back as a second, disagreeing copy.
   */
  const own = ownershipFor(plateId);
  const overrides = {};
  let skipped = 0;
  for (const [sub, type] of Object.entries(body.terrain || {})) {
    if (!validSub.has(sub)) throw new HttpError(400, `subhex "${sub}" out of range`);
    if (!types[type]) throw new HttpError(400, `unknown terrain type "${type}" (subhex ${sub})`);
    if (own.isBorrowed(plateId, sub)) { skipped++; continue; }
    if (type === defaultTerrain) continue;     // keep the grid sparse
    overrides[sub] = type;
  }

  const abs = guard.assertInScope(`plates/${plateId}.yaml`);   // structural boundary
  yamlIo.writePlateTerrain(abs, { defaultTerrain, overrides });
  return { ok: true, overrides: Object.keys(overrides).length, borrowed_skipped: skipped };
}

/* ---------- write op: line features (Phase 2), guarded ---------- */
/*
 * A path entry is either "NNN" (this plate) or "PPPP-NNN" (any plate, README §2)
 * — the qualified form is how ONE line feature crosses a plate boundary. Entries
 * that resolve to this plate are normalised back to the bare form, so a line
 * that never leaves home is written exactly as it always was.
 */
function savePlateLines(plateId, body) {
  if (!fs.existsSync(R(`plates/${plateId}.yaml`))) throw new HttpError(404, `no such plate ${plateId}`);
  const validSub = new Set(HexGeo.buildPlateHexes().map(h => h.sub));
  const lineTypes = themeRegistry().lines;
  const known = new Set(plateIds());

  const linesArr = [];
  for (const ln of (body.lines || [])) {
    if (!lineTypes[ln.type]) throw new HttpError(400, `unknown line type "${ln.type}"`);
    const path = [];
    for (const raw of (ln.path || [])) {
      const a = HexGeo.parseAddr(raw);
      if (!a) throw new HttpError(400, `line references "${raw}", which is not a subhex address (NNN or PPPP-NNN)`);
      if (!validSub.has(a.sub)) throw new HttpError(400, `line references subhex "${raw}" out of range`);
      const foreign = a.plate && a.plate !== plateId;
      if (foreign && !known.has(a.plate)) throw new HttpError(400, `line references plate ${a.plate}, which does not exist`);
      path.push(foreign ? `${a.plate}-${a.sub}` : a.sub);
    }
    if (path.length < 2) throw new HttpError(400, `a ${ln.type} needs at least 2 hexes`);
    linesArr.push({ type: ln.type, path });
  }

  const abs = guard.assertInScope(`plates/${plateId}.yaml`);   // structural boundary
  yamlIo.writePlateLines(abs, linesArr);
  return { ok: true, lines: linesArr.length };
}


/* ---------- write op: per-subhex metadata (Phase 5), guarded ---------- */
/*
 * The MAP fields of one hex file: name, visibility, feature. Two structural
 * boundaries stand between this and the story:
 *
 *   guard.assertInScope()          — the path may only be under hexes/
 *   guard.assertHexFieldsAllowed() — the key set may only be map fields
 *
 * `chronicle` and `local_memory` are owned by the living-world agent (README
 * §4). They are never assembled into `fields`, and even if they were the guard
 * refuses them — that refusal is asserted by guard.test.js.
 *
 * TERRAIN IS NOT WRITTEN HERE. It lives in the plate's terrain grid, which is
 * the single source of truth; the editor routes terrain edits to
 * PUT /api/plate/:id/terrain. A `terrain` key arriving here is refused outright
 * rather than silently dropped. (Note: guard.HEX_ALLOWED_KEYS still lists
 * "terrain" from an earlier design — see the note in the summary; nothing in
 * this endpoint relies on that entry.)
 */
function saveHex(plateId, sub, body) {
  if (!/^\d{4}$/.test(plateId)) throw new HttpError(400, `bad plate id "${plateId}"`);
  if (!/^\d{3}$/.test(sub)) throw new HttpError(400, `bad subhex number "${sub}"`);
  const validSub = new Set(HexGeo.buildPlateHexes().map(h => h.sub));
  if (!validSub.has(sub)) throw new HttpError(400, `subhex "${sub}" out of range`);
  if (!fs.existsSync(R(`plates/${plateId}.yaml`))) throw new HttpError(404, `no such plate ${plateId}`);

  /*
   * There is exactly ONE writable record per physical hex. A seam position
   * addressed through the plate that borrows it is redirected to its owner
   * here, so it cannot end up with two files that disagree — whichever plate
   * you had open when you typed.
   */
  const o = ownershipFor(plateId).ownerOf(plateId, sub);
  plateId = o.plateId; sub = o.sub;
  if ("terrain" in body) {
    throw new HttpError(400, "terrain belongs to the plate grid — use PUT /api/plate/:id/terrain");
  }
  /*
   * Refuse on what was ASKED FOR, not just on what we would have written.
   * Assembling `fields` from a known key list already makes a story write
   * impossible, but dropping `chronicle` silently and answering 200 would tell
   * the caller their write succeeded. Put the request's own key set through the
   * guard so an attempt to write story fields fails loudly, as a scope violation.
   */
  guard.assertHexFieldsAllowed(Object.keys(body));

  const featureTypes = themeRegistry().features;
  const VISIBILITY = ["public", "gm-only"];
  const text = v => { const s = v == null ? "" : String(v).trim(); return s || null; };

  // Assemble ONLY map fields. A null value means "remove this key".
  const fields = {};
  if ("name" in body) fields.name = text(body.name);
  if ("visibility" in body) {
    const v = text(body.visibility) || "public";
    if (!VISIBILITY.includes(v)) throw new HttpError(400, `unknown visibility "${v}" (${VISIBILITY.join(" | ")})`);
    fields.visibility = v;
  }
  if ("feature" in body) {
    const f = body.feature;
    if (!f || !text(f.type)) {
      fields.feature = null;                  // clearing removes the key entirely
    } else {
      const type = text(f.type);
      if (!featureTypes[type]) throw new HttpError(400, `unknown feature type "${type}"`);
      fields.feature = { type, name: text(f.name) };
    }
  }

  guard.assertHexFieldsAllowed(Object.keys(fields));           // structural boundary

  const rel = `hexes/${plateId}-${sub}.yaml`;
  const address = `${plateId}-${sub}`;
  if (fs.existsSync(R(rel))) {
    const abs = guard.assertInScope(rel);                      // structural boundary
    yamlIo.updateHexFields(abs, fields);
    return { ok: true, address, file: rel, created: false };
  }

  // Nothing worth a file yet — don't litter hexes/ with empty records.
  const empty = Object.values(fields).every(v => v === null || v === "public");
  if (empty) return { ok: true, address, file: rel, created: false, skipped: true };

  const abs = guard.assertCreatable(rel);                      // refuses to clobber
  yamlIo.writeNewHex(abs, { address, fields, eol: detectEol() });
  return { ok: true, address, file: rel, created: true };
}

/* ---------- write op: plate-level descriptive fields, guarded ---------- */
/*
 * The plate's own description — what it is called, which canton and realm it
 * belongs to, its blurb. NOT the map:
 *
 *   guard.assertPlateMetaAllowed()  — the key set may only be those fields
 *   yamlIo.updatePlateMeta()        — a surgical write, so the terrain grid,
 *                                     the lines block and every comment in the
 *                                     file come out byte-for-byte identical
 *
 * `id` is the plate's permanent identity, `terrain` and `lines` are the map,
 * and `neighbors` is the lattice. Each has its own endpoint; an attempt to send
 * one here fails loudly as a scope violation rather than being dropped.
 */
function savePlateMeta(plateId, body) {
  if (!/^\d{4}$/.test(plateId)) throw new HttpError(400, `bad plate id "${plateId}"`);
  if (!fs.existsSync(R(`plates/${plateId}.yaml`))) throw new HttpError(404, `no such plate ${plateId}`);
  guard.assertPlateMetaAllowed(Object.keys(body));            // refuse on what was ASKED for

  const text = v => { const s = v == null ? "" : String(v).trim(); return s || null; };
  const fields = {};
  for (const key of ["name", "title", "canton", "realm", "summary", "scale_label"]) {
    if (key in body) fields[key] = text(body[key]);
  }
  if ("continent_hex" in body) {
    const n = parseInt(body.continent_hex, 10);
    if (!Number.isFinite(n) || n < 1) throw new HttpError(400, `continent_hex must be a positive integer`);
    fields.continent_hex = n;
  }
  if (!Object.keys(fields).length) return { ok: true, file: `plates/${plateId}.yaml`, changed: 0 };

  guard.assertPlateMetaAllowed(Object.keys(fields));          // structural boundary
  const abs = guard.assertInScope(`plates/${plateId}.yaml`);  // structural boundary
  yamlIo.updatePlateMeta(abs, fields);
  return { ok: true, file: `plates/${plateId}.yaml`, changed: Object.keys(fields).length };
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
/*
 * The whole map in one payload. Anchored on the LOWEST plate id at (0,0) — the
 * frame never moves, so a world coordinate means the same thing for the whole
 * session and there is no such thing as "the plate you are on".
 */
function atlasOriginId() { return plateIds()[0] || "0001"; }

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
  // The registry travels with the atlas: it is the one payload the client always
  // fetches, and it needs the terrain colours before it can draw anything.
  return {
    origin: originId, plates: out, empty, conflicts, orphans, dangling,
    profiles: plateGen.PROFILES, registry: themeRegistry(),
  };
}

/*
 * One plate's full interior — the heavy data the atlas summary omits. Fetched
 * on demand when a plate crosses into detail LOD and is on screen, then cached
 * client-side. Read-only.
 */
function plateDetail(id) {
  if (!fs.existsSync(R(`plates/${id}.yaml`))) throw new HttpError(404, `no such plate ${id}`);
  const doc = readYaml(`plates/${id}.yaml`);
  const own = ownershipFor(id);
  return {
    id,
    // the plate's descriptive fields, all editable through PUT /api/plate/:id/meta
    name: doc.name || null,
    title: doc.title || null,
    canton: doc.canton != null ? doc.canton : null,
    realm: doc.realm != null ? doc.realm : null,
    summary: doc.summary ? String(doc.summary).trim() : null,
    continent_hex: doc.continent_hex != null ? doc.continent_hex : null,
    scale_label: doc.scale_label || null,
    default_terrain: doc.default_terrain,
    // RESOLVED, and complete: a borrowed seam position carries the owner's
    // terrain, so this plate can never disagree with its neighbour about a hex
    terrain: resolvedTerrain(id, own, terrainReader()),
    lines: doc.lines || [],
    hexes: readHexRecords(id, own),
    borrowed: borrowedMap(id, own),
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

  return { id, profile, seed, rolled, edgeSeeds, adjacency, fromId, pos, coord, body, theme };
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
  const { id, profile, seed, rolled, edgeSeeds, adjacency, fromId, pos, coord } = planPlate(body);

  /*
   * A new plate has the highest id, so every seam position it shares with an
   * existing neighbour belongs to that neighbour. Rolling terrain for those
   * positions is right — they are a boundary condition for the blend — but
   * WRITING them would create stale entries on the day the plate is born. Drop
   * them: the plate shows its neighbour's hex there, which is the whole point.
   */
  const lattice = Object.fromEntries([...coord, [id, pos]]);
  const own = HexGeo.plateOwnership(lattice);
  const terrain = {};
  for (const [sub, t] of Object.entries(rolled.terrain)) {
    if (!own.isBorrowed(id, sub)) terrain[sub] = t;
  }

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
    terrain,
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
    overrides: Object.keys(terrain).length,
    borrowed_skipped: Object.keys(rolled.terrain).length - Object.keys(terrain).length,
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

    // API: the whole map, on one fixed frame
    if (req.method === "GET" && p === "/api/atlas") {
      return send(res, 200, buildAtlas(atlasOriginId()));
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
    // API: PUT /api/plate/:id/meta — the plate's descriptive fields, never the map
    if (req.method === "PUT" && (m = /^\/api\/plate\/(\d{4})\/meta$/.exec(p))) {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, savePlateMeta(m[1], body));
    }
    // API: PUT /api/hex/:plateId/:sub — one hex file's MAP fields (never story)
    if (req.method === "PUT" && (m = /^\/api\/hex\/(\d{4})\/(\d{3})$/.exec(p))) {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, saveHex(m[1], m[2], body));
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
