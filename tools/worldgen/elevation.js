/*
 * PHASE A, STEP 2 — ELEVATION AND RELIEF (WORLDGEN §VII-C).
 *
 * Every subhex carries:
 *   elevation  integer FEET, negative for bathymetry
 *   relief     flat | rolling | hills | mountains, derived from the local
 *              elevation RANGE within 2 subhexes (6 miles), never from absolute
 *              height — so a high plateau is flat and a low broken country is
 *              hills, which is the distinction the biome matrix needs.
 *
 * Written before terrain in G1, because §VII-G resolves terrain from
 * (temperature × moisture × elevation × drainage) and reads elevation as an
 * input.
 *
 * OROGENY IS NOT OPTIONAL. Sampling the continentality field alone gives a
 * smooth dome: relief would be flat or rolling almost everywhere, no hex would
 * ever qualify as mountains, and §1a's alpine glacier and tundra zones would
 * have nowhere to exist. So §VII-C's structure is built explicitly — ranges are
 * LINES with asymmetric foothills, not blobs — and the continental field
 * supplies only the broad base they stand on.
 *
 * Deterministic from world_seed and position, like everything else (§0), which
 * is what lets validation rule 22 re-derive a value and compare.
 */
"use strict";
const N = require("./noise.js");
const frame = require("./frame.js");
const mask = require("./mask.js");

/* ---- elevation constants, mirrored into world/constants.yaml ---- */
const E = {
  // land
  baseCeilingFt: 1150,        // asymptote of the continental base away from coast
  baseScale: 0.78,            // field units over which the base rises
  roughFt: 760,               // erosional roughness at full strength
  roughFreq: 88.0,            // ≈15 miles per cycle, so variation registers
                              // inside the 6-mile relief window
  roughOctaves: 4,

  // REGIONAL SWELL — basins, plateaus and broad uplands at the 100-300 mile
  // scale. Without it the base saturates near its ceiling and the interior is
  // one flat expanse: the map reads as four ridges laid on a billiard table.
  // This is the scale at which watersheds and regions become distinguishable,
  // so the drainage step depends on it existing.
  regionalFt: 980,
  regionalFreq: 7.4,
  regionalOctaves: 4,

  /*
   * The ranges. §VII-C: one or two collision spines plus a rift or trailing
   * margin. Each is a POLYLINE with a half-width and a peak; foothills fall off
   * further on the `back` side than the `front`, which is what makes a range
   * read as having a windward and a leeward flank rather than being a ridge
   * drawn with a fat pen.
   *
   * Placement answers to §1a. The westerlies run west→east, so a rain shadow
   * needs a north–south barrier: the western cordillera is what makes the dry
   * interior, the badlands and the Iberian desert possible at all. The great
   * spine is the Alps analogue between the southern sea and the interior, and
   * carries the only ground high enough for glacier and tundra.
   */
  spines: [
    {
      name: "western cordillera",
      cause: "coastal collision range; the rain shadow east of it is what §1a's badlands and desert require",
      path: [[0.150, 0.300], [0.168, 0.400], [0.160, 0.500], [0.178, 0.600], [0.165, 0.700]],
      halfWidth: 0.020, backWidth: 0.050, peakFt: 7800, sillFt: 2600,
    },
    {
      name: "the great spine",
      cause: "the principal collision spine; the only ground above the snowline (§1a alpine glacier and tundra)",
      path: [[0.285, 0.690], [0.400, 0.660], [0.520, 0.638], [0.640, 0.628], [0.735, 0.645]],
      halfWidth: 0.022, backWidth: 0.055, peakFt: 13600, sillFt: 4200,
    },
    {
      name: "northern uplands",
      cause: "an older, eroded range on the northern mass; §1a puts taiga in northern upland and nowhere else",
      path: [[0.190, 0.095], [0.330, 0.125], [0.470, 0.115], [0.620, 0.150]],
      halfWidth: 0.019, backWidth: 0.042, peakFt: 5200, sillFt: 1700,
    },
    {
      name: "eastern escarpment",
      cause: "trailing-margin shoulder (§VII-C), not a collision: low, one-sided, and it fronts the continental interior",
      path: [[0.858, 0.330], [0.876, 0.440], [0.868, 0.545], [0.884, 0.640]],
      halfWidth: 0.016, backWidth: 0.038, peakFt: 3800, sillFt: 1200,
    },
  ],
  spineAlongFreq: 9.0,        // along-crest variation ⇒ massifs and passes
  spineAlongAmp: 0.42,

  // bathymetry, in subhexes of distance from the coast
  shelfSubhexes: 16,          // mean; varies with noise
  shelfVarSubhexes: 9,
  shelfFloorFt: -580,
  slopeSubhexes: 18,
  slopeFloorFt: -9200,
  abyssFt: -15600,
  abyssSubhexes: 70,
  ridgeCrestFt: -260,         // the drowned land bridge stands this shallow

  // relief classes, from the local elevation RANGE within reliefRadius subhexes
  reliefRadius: 2,            // 6 miles
  reliefBands: [
    ["flat", 250],
    ["rolling", 800],
    ["hills", 2000],
    ["mountains", Infinity],
  ],
};

const RELIEF_CODE = { flat: 0, rolling: 1, hills: 2, mountains: 3 };
const RELIEF_NAME = ["flat", "rolling", "hills", "mountains"];

/* distance from a point to a polyline, aspect-corrected, plus position along it */
function distToPath(pts, u, v, aspect) {
  let best = Infinity, bestT = 0, acc = 0, total = 0;
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const L = Math.hypot((pts[i + 1][0] - pts[i][0]) * aspect, pts[i + 1][1] - pts[i][1]);
    seg.push(L); total += L;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0] * aspect, ay = pts[i][1];
    const bx = pts[i + 1][0] * aspect, by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((u * aspect - ax) * dx + (v - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(u * aspect - (ax + t * dx), v - (ay + t * dy));
    if (d < best) { best = d; bestT = (acc + t * seg[i]) / total; }
    acc += seg[i];
  }
  // signed side, for asymmetric foothills: which flank of the nearest segment
  return { d: best, t: bestT };
}

/* which side of the polyline the point falls on (+1 / -1), for asymmetry */
function sideOfPath(pts, u, v, aspect) {
  let best = Infinity, sign = 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0] * aspect, ay = pts[i][1];
    const bx = pts[i + 1][0] * aspect, by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((u * aspect - ax) * dx + (v - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = u * aspect - (ax + t * dx), py = v - (ay + t * dy);
    const d = Math.hypot(px, py);
    if (d < best) { best = d; sign = (dx * py - dy * px) >= 0 ? 1 : -1; }
  }
  return sign;
}

/*
 * The orogenic contribution at a point, in feet. Zero away from every range.
 * Along-crest noise gives massifs and passes, so a spine is not a uniform wall —
 * which matters because §1a's pass-closure months and the corridor model in §III
 * both need somewhere to cross.
 */
function orogeny(u, v, aspect, spineN) {
  let ft = 0;
  for (let i = 0; i < E.spines.length; i++) {
    const sp = E.spines[i];
    const { d, t } = distToPath(sp.path, u, v, aspect);
    const side = sideOfPath(sp.path, u, v, aspect);
    const width = side > 0 ? sp.halfWidth : sp.backWidth;
    if (d > width * 3) continue;
    // along-crest variation: massifs and saddles
    const along = 0.5 + 0.5 * spineN.fbm(t * E.spineAlongFreq + i * 17.3, 3.1, 3, 2.2, 0.55);
    const crest = sp.sillFt + (sp.peakFt - sp.sillFt) * (1 - E.spineAlongAmp + E.spineAlongAmp * along);
    const x = d / width;
    ft += crest * Math.exp(-x * x * 2.1);   // sharper than 1.35: at 1.35 the
                                           // flanks spread until a tenth of the
                                           // continent stood above 5,800 ft
  }
  return ft;
}

/*
 * Build elevation and relief for every subhex.
 *
 * `m` is a finished mask (its cells already carry land/type/shelfF and the
 * continentality field h relative to `thresh`).
 */
function buildElevation(seed, m) {
  const b = frame.bounds();
  const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);
  const roughN = N.makeNoise(seed ^ 0x3c6ef372);
  const regionN = N.makeNoise(seed ^ 0x2545f491);
  const spineN = N.makeNoise(seed ^ 0x1b873593);
  const shelfN = N.makeNoise(seed ^ 0x7f4a7c15);
  const DIRS = mask.DIRS;

  /* --- distance to the coast, in subhexes, for bathymetry and for the
   *     continental base. Multi-source BFS from every cell on the shore. --- */
  const dist = new Map();
  {
    const q = [];
    for (const c of m.order) {
      let coastal = false;
      for (const [dq, dr] of DIRS) {
        const n = m.cells.get((c.q + dq) + "," + (c.r + dr));
        if (n && n.land !== c.land) { coastal = true; break; }
      }
      if (coastal) { dist.set(c.q + "," + c.r, 0); q.push(c); }
    }
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      const d = dist.get(c.q + "," + c.r);
      for (const [dq, dr] of DIRS) {
        const k = (c.q + dq) + "," + (c.r + dr);
        const n = m.cells.get(k);
        if (n && !dist.has(k)) { dist.set(k, d + 1); q.push(n); }
      }
    }
  }

  /* --- elevation --- */
  for (const c of m.order) {
    const dc = dist.get(c.q + "," + c.r) || 0;
    // h0, NOT h. The coastal detail in `h` exists to perturb the land/sea
    // BOUNDARY at the subhex scale; it is not topography. Reading it here put
    // roughly 1,300 ft of spurious relief along every shoreline and left the
    // continent with 41 flat subhexes in total.
    const s = c.h0 - m.thresh;                      // >0 land, <0 water

    if (c.land) {
      // the broad continental base: rises away from the coast, asymptotic
      const base = E.baseCeilingFt * (1 - Math.exp(-Math.max(0, s) / E.baseScale));
      const oro = orogeny(c.u, c.v, aspect, spineN);
      const regional = E.regionalFt * regionN.fbm(c.u * aspect * E.regionalFreq,
        c.v * E.regionalFreq, E.regionalOctaves, 2.0, 0.55);
      // erosion roughness, stronger where the ground is already high
      const r = roughN.fbm(c.u * aspect * E.roughFreq, c.v * E.roughFreq,
        E.roughOctaves, 2.1, 0.55);
      const highness = N.clamp01((base + regional + oro) / 3200);
      // lowlands must be genuinely smooth or nothing is ever `flat`
      const rough = E.roughFt * r * (0.15 + 0.85 * highness);
      c.elevation = Math.max(1, Math.round(base + regional + oro + rough));
    } else {
      // bathymetry: shelf, then slope, then abyssal plain
      const sv = 0.5 + 0.5 * shelfN.fbm(c.u * aspect * 7.5, c.v * 7.5, 3, 2.1, 0.55);
      const shelfEdge = E.shelfSubhexes + E.shelfVarSubhexes * (sv * 2 - 1);
      let ft;
      if (dc <= shelfEdge) {
        ft = E.shelfFloorFt * (dc / Math.max(1, shelfEdge));
      } else if (dc <= shelfEdge + E.slopeSubhexes) {
        const t = (dc - shelfEdge) / E.slopeSubhexes;
        ft = E.shelfFloorFt + (E.slopeFloorFt - E.shelfFloorFt) * (t * t * (3 - 2 * t));
      } else {
        const t = N.clamp01((dc - shelfEdge - E.slopeSubhexes) /
          Math.max(1, E.abyssSubhexes - shelfEdge - E.slopeSubhexes));
        ft = E.slopeFloorFt + (E.abyssFt - E.slopeFloorFt) * t;
      }
      // the drowned ridge stands proud of whatever is around it (§VII-B)
      if (c.shelfF > 0) ft = Math.max(ft, E.ridgeCrestFt * (1 - 0.55 * c.shelfF) + E.ridgeCrestFt * 0.55 * c.shelfF);
      if (c.shelfF > 0.15) ft = Math.max(ft, E.ridgeCrestFt);
      const r = roughN.fbm(c.u * aspect * 26 + 4.4, c.v * 26 + 8.8, 3, 2.1, 0.55);
      ft += 420 * r * N.clamp01(dc / 12);
      // rule 23: a water subhex may never carry a positive elevation
      c.elevation = Math.min(-1, Math.round(ft));
    }
  }

  /* --- relief, from the local elevation RANGE (not the height) --- */
  const R = E.reliefRadius;
  for (const c of m.order) {
    let lo = Infinity, hi = -Infinity;
    for (let dq = -R; dq <= R; dq++) {
      const loR = Math.max(-R, -dq - R), hiR = Math.min(R, -dq + R);
      for (let dr = loR; dr <= hiR; dr++) {
        const n = m.cells.get((c.q + dq) + "," + (c.r + dr));
        if (!n) continue;
        if (n.elevation < lo) lo = n.elevation;
        if (n.elevation > hi) hi = n.elevation;
      }
    }
    const range = (hi === -Infinity) ? 0 : hi - lo;
    c.reliefRange = range;
    for (const [name, cap] of E.reliefBands) {
      if (range < cap) { c.relief = name; break; }
    }
  }

  return { E, dist };
}

/* stats worth printing and worth recording */
function elevationStats(m) {
  const land = m.order.filter(c => c.land), sea = m.order.filter(c => !c.land);
  const pick = (arr, f, p) => {
    const v = arr.map(f).sort((a, b) => a - b);
    return v[Math.floor((v.length - 1) * p)];
  };
  const reliefCount = {};
  for (const n of RELIEF_NAME) reliefCount[n] = 0;
  for (const c of m.order) reliefCount[c.relief]++;
  const reliefLand = {};
  for (const n of RELIEF_NAME) reliefLand[n] = 0;
  for (const c of land) reliefLand[c.relief]++;
  return {
    land: {
      n: land.length,
      min: pick(land, c => c.elevation, 0), p50: pick(land, c => c.elevation, 0.5),
      p90: pick(land, c => c.elevation, 0.9), p99: pick(land, c => c.elevation, 0.99),
      max: pick(land, c => c.elevation, 1),
      mean: Math.round(land.reduce((t, c) => t + c.elevation, 0) / land.length),
    },
    sea: {
      n: sea.length,
      max: pick(sea, c => c.elevation, 1), p50: pick(sea, c => c.elevation, 0.5),
      min: pick(sea, c => c.elevation, 0),
      mean: Math.round(sea.reduce((t, c) => t + c.elevation, 0) / sea.length),
    },
    relief: reliefCount,
    reliefLand,
    aboveSnowline: land.filter(c => c.elevation >= 8500).length,
  };
}

module.exports = { buildElevation, elevationStats, E, RELIEF_CODE, RELIEF_NAME, orogeny };
