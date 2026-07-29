/*
 * PHASE A, STEP 1 — THE LAND–SEA MASK (WORLDGEN §VII-A).
 *
 * "The single most consequential call in the project and everything else is
 * downstream of it." Nothing here reads elevation, moisture or drainage; those
 * are computed FROM this, after it is approved (§9).
 *
 * Settled inputs:
 *   - ~30% water, one bulky landmass (Phase 0 Q1, answered: "bulkier landmass" —
 *     more continental interior, fewer coasts, stronger east-side rain shadow).
 *   - Land reaches the frame edge NOWHERE; open water rings the world (§VII-A,
 *     validation rule 11).
 *   - A southern inland sea, joined to the world ocean by a strait. §1a leans on
 *     it hard: a tideless southern sea is what produces many small maritime
 *     powers against the north's fewer large land powers. Because it connects,
 *     it is `ocean` (salt) under §VII-G, not `water`.
 *
 * The field is continuous and analytic; the subhex lattice merely samples it, so
 * neighbouring plates agree along their seam with no special-casing (§VII).
 */
"use strict";
const N = require("./noise.js");
const frame = require("./frame.js");

/* ---- tunables, all recorded in world/constants.yaml ---- */
const P = {
  targetWater: 0.30,          // Phase 0 Q1

  // domain warp — two octaves of it, at continental scale. This is what turns
  // a dome into a coastline with capes and gulfs instead of an arc.
  warpAmp: 0.355,
  warpFreq: 1.55,

  contFreq: 1.95,             // continent-scale features; low ⇒ bulky
  contOctaves: 6,
  contGain: 0.50,
  contAmp: 1.02,

  // THE CONTINENTAL DOME. A single broad mass with open ocean all round. An
  // ellipse inscribed in the frame is π/4 ≈ 78% of it, so a noisy dome of about
  // this size lands naturally near the 70% land the water target asks for —
  // the ring is then a consequence of the continent's shape, not a stamp
  // pressed over the top of it.
  domeCentre: [0.475, 0.455],
  domeRadius: 0.520,
  domeAmp: 0.40,

  // The edge guarantee (§VII-A, rule 11) is now a PENALTY that bites only in
  // the outermost 7%, not a multiplier over the whole field. Land can crowd the
  // margin in one place and retreat far from it in another; it can never reach
  // it, because the penalty is unbounded at d = 0.
  edgeBite: 0.055,
  edgePower: 2.0,
  edgeAmp: 4.0,

  // THE SOUTHERN SEA (§1a). Built as a chain of overlapping basins running
  // WSW–ENE, with a mouth blob planted INSIDE the southern ocean margin so the
  // basin cannot fail to connect. Connected ⇒ salt ⇒ `ocean` (§VII-G, rule 14).
  seaAxis: [[0.28, 0.700], [0.44, 0.735], [0.60, 0.745], [0.735, 0.715]],
  seaRadius: 0.135,
  seaDepth: 0.95,
  seaWarp: 0.40,
  // The mouth starts ON the sea axis and runs past the frame edge (v > 1), so
  // the channel is continuous by CONSTRUCTION rather than by a lucky overlap
  // between two blobs. An earlier version ended at v = 0.965 and the sea
  // silently became a 130,000-square-mile lake when the noise shifted.
  mouth: [[0.285, 0.700], [0.245, 0.795], [0.205, 0.885], [0.175, 0.980], [0.160, 1.060]],
  mouthRadius: 0.070,
  mouthDepth: 1.15,

  // A deep western gulf, so the Atlantic west coast is an indented one that can
  // carry rias and harbours (§VII-F) rather than a smooth wall.
  gulfCentre: [0.115, 0.315],
  gulfRadius: 0.115,
  gulfDepth: 0.62,
};

/* smooth minimum-distance to a polyline, in aspect-corrected space */
function distToPath(pts, u, v, aspect) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0] * aspect, ay = pts[i][1];
    const bx = pts[i + 1][0] * aspect, by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((u * aspect - ax) * dx + (v - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(u * aspect - (ax + t * dx), v - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/*
 * The continentality field. > threshold is land.
 *
 * u,v are frame fractions; noise is sampled in aspect-corrected space so a
 * feature is the same size east–west as north–south rather than smeared by the
 * frame being wider than it is tall.
 */
function makeField(seed) {
  const warp = N.makeNoise(seed ^ 0x9e3779b9);
  const cont = N.makeNoise(seed);
  const b = frame.bounds();
  const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);

  return function field(u, v) {
    const au = u * aspect;

    // domain warp — the difference between a potato and a coastline
    const wx = warp.fbm(au * P.warpFreq, v * P.warpFreq, 4);
    const wy = warp.fbm(au * P.warpFreq + 31.7, v * P.warpFreq + 17.3, 4);
    const su = au + P.warpAmp * wx, sv = v + P.warpAmp * wy;

    // the dome, evaluated in WARPED space so its rim is ragged, not elliptical
    const ddx = (su - P.domeCentre[0] * aspect), ddy = (sv - P.domeCentre[1]);
    const dr = Math.hypot(ddx, ddy) / P.domeRadius;
    const dome = P.domeAmp * (1 - dr * dr);

    const detail = P.contAmp * cont.fbm(su * P.contFreq, sv * P.contFreq,
      P.contOctaves, 2.0, P.contGain);

    let h = dome + detail;

    // OPEN WATER RINGS THE WORLD (§VII-A). Unbounded at the border, zero past
    // edgeBite: a floor under the coastline, not a stamp over the whole field.
    const d = Math.min(u, 1 - u, v, 1 - v);
    const e = 1 - N.smoothstep(0, P.edgeBite, d);
    h -= P.edgeAmp * Math.pow(e, P.edgePower);

    // the southern sea, warped so it is a sea and not a lozenge
    const sw = warp.fbm(au * 3.4 + 11.7, v * 3.4 + 4.4, 3);
    const dS = distToPath(P.seaAxis, u, v, aspect) / (P.seaRadius * (1 + P.seaWarp * sw));
    h -= P.seaDepth * (1 - N.smoothstep(0.35, 1.15, dS));

    // …and its mouth, which reaches into the southern ocean margin
    const dM = distToPath(P.mouth, u, v, aspect) / (P.mouthRadius * (1 + 0.3 * sw));
    h -= P.mouthDepth * (1 - N.smoothstep(0.3, 1.2, dM));

    // the western gulf
    const dgx = (u - P.gulfCentre[0]) * aspect, dgy = v - P.gulfCentre[1];
    const dG = Math.hypot(dgx, dgy) / (P.gulfRadius * (1 + 0.45 * sw));
    h -= P.gulfDepth * (1 - N.smoothstep(0.3, 1.15, dG));

    return h;
  };
}

/*
 * Calibrate the land threshold so the water fraction lands on target. Bisection
 * on the ACTUAL subhex sample set, not on the analytic field — the lattice is
 * what gets written, so it is what must hit 30%.
 */
function calibrate(values, targetWater) {
  let lo = -1, hi = 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    let wet = 0;
    for (let k = 0; k < values.length; k++) if (values[k] <= mid) wet++;
    if (wet / values.length < targetWater) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/*
 * Build the mask over the world subhex lattice.
 *
 * Returns { cells, order, stats }. `cells` maps "q,r" → record; `order` is a
 * stable array of the same records. Water is classified by CONNECTIVITY, not by
 * size: anything reachable from the frame border through water is `ocean`
 * (salt); anything enclosed by land is `water` (fresh). That is §VII-G's rule
 * and validation rule 14 checks it directly.
 */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

/* connected components over cells satisfying `pred` */
function components(order, byKey, pred) {
  const seen = new Set(), out = [];
  for (const c of order) {
    if (!pred(c) || seen.has(c)) continue;
    const comp = [c]; seen.add(c);
    const st = [c];
    while (st.length) {
      const x = st.pop();
      for (const [dq, dr] of DIRS) {
        const n = byKey.get((x.q + dq) + "," + (x.r + dr));
        if (n && pred(n) && !seen.has(n)) { seen.add(n); comp.push(n); st.push(n); }
      }
    }
    out.push(comp);
  }
  return out.sort((a, b) => b.length - a.length);
}

/* Classify one thresholding of the field: land/ocean/water plus despeckling.
 * MIN_ISLAND / MIN_LAKE drop features too small to have a cause — §VII-B wants
 * every island chain to have a geology and §VII-E only allows a lake in a
 * closed basin, so a two-hex speck of either is noise, not a landform. */
const MIN_ISLAND = 12;
const MIN_LAKE = 25;

function classify(order, byKey, thresh) {
  for (const c of order) { c.land = c.h > thresh; c.type = null; }

  // despeckle land, then water, then recompute connectivity from scratch
  for (const m of components(order, byKey, c => c.land).slice(1)) {
    if (m.length < MIN_ISLAND) for (const c of m) c.land = false;
  }
  for (const w of components(order, byKey, c => !c.land)) {
    if (w.length < MIN_LAKE) for (const c of w) c.land = true;
  }

  /* the world ocean: flood in from the frame border. A border cell is one
   * missing at least one lattice neighbour. */
  const seeds = [];
  for (const c of order) {
    if (c.land) continue;
    for (const [dq, dr] of DIRS) {
      if (!byKey.has((c.q + dq) + "," + (c.r + dr))) { seeds.push(c); break; }
    }
  }
  const stack = seeds.slice();
  for (const s of seeds) s.type = "ocean";
  while (stack.length) {
    const c = stack.pop();
    for (const [dq, dr] of DIRS) {
      const n = byKey.get((c.q + dq) + "," + (c.r + dr));
      if (n && !n.land && !n.type) { n.type = "ocean"; stack.push(n); }
    }
  }
  for (const c of order) c.type = c.land ? "land" : (c.type || "water");
  return order.filter(c => !c.land).length / order.length;
}

function buildMask(seed) {
  const field = makeField(seed);
  const b = frame.bounds();
  const lattice = frame.subhexLattice();

  const order = [];
  for (const cell of lattice.values()) {
    const { u, v } = frame.project(cell.x, cell.y, b);
    order.push({
      q: cell.q, r: cell.r, x: cell.x, y: cell.y,
      owner: cell.owner, sub: cell.sub, u, v,
      lat: frame.latOf(v),
      h: field(u, v),
      land: false, type: null,
    });
  }
  const byKey = new Map(order.map(c => [c.q + "," + c.r, c]));

  /* Calibrate against the POST-DESPECKLE fraction: filling specks moves the
   * water fraction, so calibrating on the raw threshold would miss the target. */
  let lo = -2, hi = 2, thresh = 0;
  for (let i = 0; i < 34; i++) {
    thresh = (lo + hi) / 2;
    if (classify(order, byKey, thresh) < P.targetWater) lo = thresh; else hi = thresh;
  }
  thresh = (lo + hi) / 2;
  classify(order, byKey, thresh);

  const masses = components(order, byKey, c => c.land);
  const freshBodies = components(order, byKey, c => c.type === "water");

  const nLand = order.filter(c => c.land).length;
  const nOcean = order.filter(c => c.type === "ocean").length;
  const nFresh = order.filter(c => c.type === "water").length;
  const SQ_MI = 3 * 3 * Math.sqrt(3) / 2;          // area of a 3-mile-across hex

  return {
    cells: byKey, order, thresh, params: P,
    stats: {
      total: order.length,
      land: nLand, ocean: nOcean, fresh: nFresh,
      waterFraction: (nOcean + nFresh) / order.length,
      landSqMi: Math.round(nLand * SQ_MI),
      landmasses: masses.map(m => m.length),
      freshBodies: freshBodies.map(f => f.length),
    },
  };
}

module.exports = { buildMask, makeField, P };
