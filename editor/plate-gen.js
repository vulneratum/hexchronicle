/*
 * Plate generator — rolls the interior of a NEW 36-mile hex.
 *
 * Pure and deterministic: same (seed, plate id, profile, edge seeds) always
 * yields the same 157 subhexes. No filesystem access, no globals, no writes —
 * the caller decides what to do with the result. That makes it trivially
 * testable and means a re-roll is an explicit act, never a surprise.
 *
 * It CANNOT touch a neighbouring plate: it is handed a read-only list of edge
 * seeds (terrain sampled from across the border) and returns terrain for THIS
 * plate's subhex numbers only. Neighbour data is a boundary condition, never
 * an output.
 *
 *   generatePlate({ hexes, types, profile, seed, edgeSeeds }) ->
 *     { defaultTerrain, terrain: { "NNN": type, ... }, counts, seedCount }
 */
"use strict";

const HexGeo = require("../shared/geometry.js");

/* ------------------------------------------------------------------ *
 * Biome profiles — the "character" of a plate. Weights are relative.
 * `waterBias` steers water regions: "edge" reads as coast, "center" as lake.
 * ------------------------------------------------------------------ */
const PROFILES = {
  lowland: {
    label: "Lowland",
    weights: { plains: 46, forest: 22, hills: 18, water: 6, swamp: 5, mountains: 3 },
    regions: [12, 17], waterBias: "center", roughen: 1,
  },
  woodland: {
    label: "Woodland",
    weights: { forest: 48, plains: 22, hills: 18, water: 5, swamp: 5, mountains: 2 },
    regions: [10, 15], waterBias: "center", roughen: 1,
  },
  highland: {
    label: "Highland",
    weights: { mountains: 30, hills: 38, forest: 16, plains: 12, water: 3, swamp: 1 },
    regions: [11, 16], waterBias: "center", roughen: 2,
  },
  coastal: {
    label: "Coastal",
    weights: { water: 34, plains: 26, forest: 16, hills: 13, swamp: 9, mountains: 2 },
    regions: [9, 13], waterBias: "edge", roughen: 1,
  },
  marsh: {
    label: "Marsh",
    weights: { swamp: 34, water: 24, plains: 20, forest: 15, hills: 6, mountains: 1 },
    regions: [10, 15], waterBias: "center", roughen: 1,
  },
  arid: {
    label: "Arid",
    weights: { plains: 40, hills: 32, mountains: 20, forest: 7, water: 1, swamp: 0 },
    regions: [10, 15], waterBias: "center", roughen: 2,
  },
};

/* ------------------------------------------------------------------ *
 * Deterministic RNG (mulberry32 + FNV-1a string hash).
 * ------------------------------------------------------------------ */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Apportion `total` region seeds across terrain types in proportion to their
 * weights (largest-remainder). Drawing each seed independently at random let
 * low-weight types vanish entirely — an "arid" plate with no mountains at all —
 * so the split is computed rather than rolled, and any type carrying real
 * weight is guaranteed at least one region.
 */
function apportionSeeds(total, weights) {
  const keys = Object.keys(weights).filter(k => weights[k] > 0);
  const sum = keys.reduce((a, k) => a + weights[k], 0);
  const exact = keys.map(k => ({ k, v: (total * weights[k]) / sum }));

  const out = {};
  let used = 0;
  for (const e of exact) { out[e.k] = Math.floor(e.v); used += out[e.k]; }

  const rem = exact.map(e => ({ k: e.k, f: e.v - Math.floor(e.v) })).sort((a, b) => b.f - a.f);
  for (let i = 0; used < total && rem.length; i++, used++) out[rem[i % rem.length].k]++;

  for (const k of keys) if (!out[k] && weights[k] / sum >= 0.04) out[k]++;
  return out;
}

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */
function generatePlate(opts) {
  const hexes = opts.hexes || HexGeo.buildPlateHexes();
  const types = opts.types || {};                       // theme registry: { key: {color,label} }
  const profileKey = PROFILES[opts.profile] ? opts.profile : "lowland";
  const profile = PROFILES[profileKey];
  const rng = mulberry32(hashSeed(String(opts.seed == null ? "hexchronicle" : opts.seed)));

  // Only offer terrain types the theme actually knows about (README §7:
  // theme/terrain.yaml is the single source of truth for terrain keys).
  const weights = {};
  for (const [k, w] of Object.entries(profile.weights)) if (types[k]) weights[k] = w;
  if (!Object.keys(weights).length) throw new Error("no profile terrain types exist in theme/terrain.yaml");

  const bySub = new Map(hexes.map(h => [h.sub, h]));
  const byKey = new Map(hexes.map(h => [h.key, h]));
  const neighborsOf = h => HexGeo.neighborDirs
    .map(([dq, dr]) => byKey.get((h.q + dq) + "," + (h.r + dr)))
    .filter(Boolean);

  // Radial position 0 (centre) .. 1 (rim), used for water bias and edge logic.
  const maxR = Math.max(...hexes.map(h => Math.hypot(h.x, h.y))) || 1;
  const rimness = h => Math.hypot(h.x, h.y) / maxR;

  /* --- 1. fixed cells: terrain dictated by an existing neighbouring plate --- */
  const assigned = new Map();      // sub -> terrain
  const fixed = new Set();         // subs that smoothing must not alter
  for (const s of (opts.edgeSeeds || [])) {
    if (!bySub.has(s.sub) || !types[s.type]) continue;
    assigned.set(s.sub, s.type);
    fixed.add(s.sub);
  }

  /* --- 2. interior region seeds --- */
  const [minReg, maxReg] = profile.regions;
  const target = minReg + Math.floor(rng() * (maxReg - minReg + 1));

  const quota = apportionSeeds(target, weights);
  const seedTypes = shuffle(rng, Object.entries(quota).flatMap(([k, n]) => Array(n).fill(k)));

  const seedSubs = [];
  const tooClose = h => seedSubs.some(s =>
    Math.hypot(bySub.get(s).x - h.x, bySub.get(s).y - h.y) < HexGeo.SIZE * 2.2);

  for (const type of seedTypes) {
    // Site each seed by sampling candidates and scoring them, so water follows
    // the profile's intent (coast hugs the rim, lakes sit inland) instead of
    // landing wherever the first roll fell.
    let best = null, bestScore = -Infinity;
    for (let tries = 0; tries < 24; tries++) {
      const h = hexes[Math.floor(rng() * hexes.length)];
      if (assigned.has(h.sub) || tooClose(h)) continue;
      let score = rng() * 0.25;
      if (type === "water") {
        const rim = rimness(h);
        score += profile.waterBias === "edge" ? rim : 1 - Math.abs(rim - 0.35);
      }
      if (score > bestScore) { bestScore = score; best = h; }
    }
    if (!best) continue;
    assigned.set(best.sub, type);
    seedSubs.push(best.sub);
  }

  /* --- 3. randomised multi-source growth (blobby regions, not Voronoi cells) --- */
  let frontier = [];
  for (const sub of assigned.keys()) {
    for (const n of neighborsOf(bySub.get(sub))) {
      if (!assigned.has(n.sub)) frontier.push({ sub: n.sub, from: assigned.get(sub) });
    }
  }
  let steps = 0;
  while (frontier.length && steps++ < 20000) {
    const i = Math.floor(rng() * frontier.length);
    const cell = frontier.splice(i, 1)[0];
    if (assigned.has(cell.sub)) continue;
    assigned.set(cell.sub, cell.from);
    for (const n of neighborsOf(bySub.get(cell.sub))) {
      if (!assigned.has(n.sub)) frontier.push({ sub: n.sub, from: cell.from });
    }
  }
  // anything still unassigned (isolated cells) takes the commonest weight
  const fallback = Object.keys(weights).sort((a, b) => weights[b] - weights[a])[0];
  for (const h of hexes) if (!assigned.has(h.sub)) assigned.set(h.sub, fallback);

  /* --- 4. smoothing: kill single-hex speckle, keep fixed border cells --- */
  for (let pass = 0; pass < 2; pass++) {
    const snapshot = new Map(assigned);
    for (const h of hexes) {
      if (fixed.has(h.sub)) continue;
      const tally = {};
      const ns = neighborsOf(h);
      for (const n of ns) { const t = snapshot.get(n.sub); tally[t] = (tally[t] || 0) + 1; }
      const mine = snapshot.get(h.sub);
      const best = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      if (best && best !== mine && tally[best] >= 4 && (tally[mine] || 0) <= 1) assigned.set(h.sub, best);
    }
  }

  /* --- 5. relief transition: mountains sit inside hills, not on open plains --- */
  if (types.hills && types.mountains) {
    for (let pass = 0; pass < profile.roughen; pass++) {
      const snapshot = new Map(assigned);
      for (const h of hexes) {
        if (fixed.has(h.sub) || snapshot.get(h.sub) !== "mountains") continue;
        for (const n of neighborsOf(h)) {
          if (fixed.has(n.sub)) continue;
          const t = snapshot.get(n.sub);
          if (t === "plains" || t === "swamp") assigned.set(n.sub, "hills");
        }
      }
    }
  }

  /* --- 6. pick the modal terrain as default so the YAML grid stays sparse --- */
  const counts = {};
  for (const h of hexes) { const t = assigned.get(h.sub); counts[t] = (counts[t] || 0) + 1; }
  const defaultTerrain = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))[0];

  const terrain = {};
  for (const h of hexes) {
    const t = assigned.get(h.sub);
    if (t !== defaultTerrain) terrain[h.sub] = t;
  }

  return { defaultTerrain, terrain, counts, seedCount: seedSubs.length, profile: profileKey };
}

/* ------------------------------------------------------------------ *
 * Edge seeds — sample an existing neighbour's terrain across the border.
 *
 * READ-ONLY with respect to the neighbour. Plates tile as point-up hexagons
 * of circumradius RL, so a neighbour's centre sits √3·RL away along the
 * direction angle. Projecting the neighbour's subhexes into THIS plate's local
 * frame tells us which of its hexes lie just beyond our rim; our hexes within
 * one hex-step of those inherit their terrain as a fixed boundary condition.
 * ------------------------------------------------------------------ */
const DIR_ANGLE = { e: 0, se: 60, sw: 120, w: 180, nw: 240, ne: 300 };
const OPPOSITE = { e: "w", w: "e", ne: "sw", sw: "ne", nw: "se", se: "nw" };

function computeEdgeSeeds(hexes, neighborTerrainByDir) {
  const STEP = Math.sqrt(3) * HexGeo.SIZE;         // centre-to-centre of adjacent subhexes
  const SPAN = Math.sqrt(3) * HexGeo.RL;           // centre-to-centre of adjacent plates
  const votes = new Map();                          // sub -> { type: count }

  for (const [dir, terrainByNum] of Object.entries(neighborTerrainByDir || {})) {
    if (!terrainByNum || !(dir in DIR_ANGLE)) continue;
    const a = Math.PI / 180 * DIR_ANGLE[dir];
    const ox = Math.cos(a) * SPAN, oy = Math.sin(a) * SPAN;

    // the neighbour's hexes, expressed in our coordinate frame
    const projected = hexes.map(h => ({ x: h.x + ox, y: h.y + oy, type: terrainByNum[h.sub] }))
      .filter(p => p.type);

    for (const h of hexes) {
      for (const p of projected) {
        if (Math.abs(p.x - h.x) > STEP * 1.15 || Math.abs(p.y - h.y) > STEP * 1.15) continue;
        if (Math.hypot(p.x - h.x, p.y - h.y) > STEP * 1.15) continue;
        if (!votes.has(h.sub)) votes.set(h.sub, {});
        const v = votes.get(h.sub);
        v[p.type] = (v[p.type] || 0) + 1;
      }
    }
  }

  const seeds = [];
  for (const [sub, tally] of votes) {
    const type = Object.keys(tally).sort((a, b) => tally[b] - tally[a] || a.localeCompare(b))[0];
    seeds.push({ sub, type });
  }
  return seeds;
}

module.exports = {
  PROFILES, DIR_ANGLE, OPPOSITE,
  generatePlate, computeEdgeSeeds, hashSeed, mulberry32,
};
