/*
 * PHASE A, STEP 1 — THE LAND–SEA MASK (WORLDGEN §VII-A).
 *
 * "The single most consequential call in the project and everything else is
 * downstream of it." Nothing here reads elevation, moisture or drainage; those
 * are computed FROM this, after it is approved (§9).
 *
 * Settled inputs:
 *   - ~40% water / ~60% land.
 *   - TWO landmasses divided by a north–south channel: a smaller Atlantic west
 *     and a larger continental east (§1a's two climate modes made geographic).
 *     The added water over the earlier 30% goes to the EAST AND WEST MARGINS and
 *     into the channel — not spread evenly, which would only have shrunk the
 *     continent all round.
 *   - A DROWNED RIDGE across the channel's narrow northern end: the remnant of
 *     the land bridge whose collapse made the split. It carries the archipelago,
 *     so the stepping stones and the chokepoint are the same place — one cause,
 *     one geological story, per §VII-B's "each chain gets a geological cause".
 *   - Land reaches the frame edge NOWHERE; open water rings the world (§VII-A,
 *     validation rule 11).
 *   - The southern sea (§1a's tideless Mediterranean) survives, and the channel
 *     now opens into it, so the two are one navigable system.
 *
 * The field is continuous and analytic; the subhex lattice merely samples it, so
 * neighbouring plates agree along their seam with no special-casing (§VII).
 */
"use strict";
const N = require("./noise.js");
const frame = require("./frame.js");

/* ---- tunables, all recorded in world/constants.yaml ---- */
const P = {
  targetWater: 0.40,

  // domain warp — two octaves of it, at continental scale. This is what turns
  // a dome into a coastline with capes and gulfs instead of an arc.
  warpAmp: 0.355,
  warpFreq: 1.55,

  contFreq: 1.95,             // continent-scale features; low ⇒ bulky
  contOctaves: 6,
  contGain: 0.50,
  contAmp: 1.02,

  // THE CONTINENTAL DOME — one broad mass, which the channel then divides.
  domeCentre: [0.475, 0.455],
  domeRadius: 0.520,
  domeAmp: 0.40,

  // THE EDGE GUARANTEE (§VII-A, rule 11) is a penalty unbounded at the border
  // and zero past its bite — a floor under the coastline, not a stamp over the
  // whole field. ASYMMETRIC: east and west bite roughly twice as deep as north
  // and south, which is where the extra water was asked to go.
  edgeBiteEW: 0.108,
  edgeBiteNS: 0.055,
  edgePower: 2.0,
  edgeAmp: 4.0,

  // THE CHANNEL. Runs the full height of the frame, joining the northern ocean
  // to the southern sea. Narrow in the NORTH — that is the chokepoint, and the
  // drowned ridge sits on it — and broad in the south where it opens out.
  channelAxis: [[0.365, -0.060], [0.352, 0.130], [0.344, 0.300],
                [0.336, 0.470], [0.322, 0.640], [0.305, 0.780]],
  channelHalfNorth: 0.048,    // frame fractions ⇒ ~63 miles at the chokepoint
  channelHalfSouth: 0.086,    // ⇒ ~113 miles where it meets the southern sea
  channelDepth: 1.30,
  channelWarp: 0.34,

  // THE DROWNED RIDGE. Two parts, because one continuous crest tuned to just
  // break the surface comes out as a RIBBON down the middle of the channel —
  // a bar, not an archipelago.
  //
  //   ridgeBase   a low continuous swell along the channel axis. Never
  //               surfaces. This is the land bridge itself, and it is what
  //               makes the shallow shelf (§VII-B).
  //   seamounts   discrete highs ON that ridge, which do surface. Placing them
  //               explicitly is both controllable and geologically honest: a
  //               drowned ridge stands proud at intervals, not evenly.
  ridgeSpan: [0.050, 0.370],  // v range: the channel's narrow northern end
  // The swell contributes NOTHING to height — it is bathymetry only. Any
  // positive value fuses the seamounts into a bar down the channel: at 0.12
  // the chain came out 39 miles wide and 200 long. Land in the channel comes
  // from seamounts and nowhere else, so each island is a discrete high.
  ridgeBaseAmp: 0.0,
  ridgeHalf: 0.030,
  // [v, radius, amplitude] — amplitude is what decides how much of each
  // seamount clears the water, so it sets island area directly.
  // The channel is ~126 miles wide here, so an island with open water on both
  // sides tops out near 40 miles across — roughly 900 sq mi. Anything larger
  // spans the strait and stops being an island.
  seamounts: [
    [0.078, 0.016, 0.5096],
    [0.112, 0.013, 0.4312],
    [0.152, 0.020, 0.5880],   // the large one — ~950 sq mi, 28 x 47 miles
    [0.196, 0.012, 0.3822],
    [0.238, 0.018, 0.5586],
    [0.278, 0.011, 0.3724],
    [0.316, 0.016, 0.5096],
    [0.350, 0.011, 0.3528],
  ],
  seamountWarp: 0.42,         // so they are islands, not discs
  shelfHalf: 0.055,           // shallow water reach around the chain (§VII-B)

  // THE SOUTHERN SEA (§1a). A basin chain whose mouth polyline starts ON the
  // sea axis and runs past the frame edge, so the channel to the world ocean is
  // continuous by CONSTRUCTION rather than by a lucky overlap between blobs.
  seaAxis: [[0.28, 0.700], [0.44, 0.735], [0.60, 0.745], [0.735, 0.715]],
  seaRadius: 0.135,
  seaDepth: 0.95,
  seaWarp: 0.40,
  mouth: [[0.285, 0.700], [0.245, 0.795], [0.205, 0.885], [0.175, 0.980], [0.160, 1.060]],
  mouthRadius: 0.070,
  mouthDepth: 1.15,

  // A gulf on the western mass's own Atlantic coast, so it can carry rias and
  // harbours (§VII-F) rather than being a smooth wall. Pulled west and tightened
  // now that the channel takes the mass's eastern side.
  gulfCentre: [0.093, 0.315],
  gulfRadius: 0.088,
  gulfDepth: 0.58,

  // Despeckle floors. §VII-B wants every island chain to have a geology and
  // §VII-E only allows a lake in a closed basin, so a speck of either is noise —
  // EXCEPT on the drowned ridge, where small islands are exactly the expected
  // form of a broken land bridge and are kept down to 3 subhexes.
  minIslandOpen: 12,
  minIslandRidge: 3,
  minLake: 25,
};

/* smooth minimum-distance to a polyline, in aspect-corrected space.
 * Also returns t: how far along the path the nearest point lies, 0..1. */
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
  return { d: best, t: bestT };
}

/*
 * The continentality field. > threshold is land.
 *
 * Returns { h, ridge, chan } per sample: `h` decides land/sea, `ridge` is
 * proximity to the drowned ridge crest (0..1, drives the shelf and the relaxed
 * despeckle floor), `chan` marks the channel corridor.
 *
 * u,v are frame fractions; noise is sampled in aspect-corrected space so a
 * feature is the same size east–west as north–south rather than smeared by the
 * frame being wider than it is tall.
 */
function makeField(seed) {
  const warp = N.makeNoise(seed ^ 0x9e3779b9);
  const cont = N.makeNoise(seed);
  const ridgeN = N.makeNoise(seed ^ 0x5bf03635);
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

    // OPEN WATER RINGS THE WORLD, deeper on east and west than north and south
    const eW = 1 - N.smoothstep(0, P.edgeBiteEW, u);
    const eE = 1 - N.smoothstep(0, P.edgeBiteEW, 1 - u);
    const eN = 1 - N.smoothstep(0, P.edgeBiteNS, v);
    const eS = 1 - N.smoothstep(0, P.edgeBiteNS, 1 - v);
    const e = Math.max(Math.max(eW, eE), Math.max(eN, eS));
    h -= P.edgeAmp * Math.pow(e, P.edgePower);

    const sw = warp.fbm(au * 3.4 + 11.7, v * 3.4 + 4.4, 3);

    // THE CHANNEL — half-width interpolated north→south, so the chokepoint is
    // at the top and it opens where it meets the southern sea
    const ch = distToPath(P.channelAxis, u, v, aspect);
    const half = N.lerp(P.channelHalfNorth, P.channelHalfSouth, N.clamp01(ch.t))
      * (1 + P.channelWarp * sw);
    const chan = 1 - N.smoothstep(0.55, 1.25, ch.d / half);
    h -= P.channelDepth * chan;

    // THE DROWNED RIDGE — a low swell that never reaches the surface. It is
    // what the shallow shelf is made of, and what the seamounts stand on.
    const inSpan = N.smoothstep(P.ridgeSpan[0] - 0.05, P.ridgeSpan[0] + 0.02, v)
                 * (1 - N.smoothstep(P.ridgeSpan[1] - 0.02, P.ridgeSpan[1] + 0.05, v));
    const across = 1 - N.smoothstep(0.30, 1.0, ch.d / P.ridgeHalf);
    const ridge = inSpan * across;
    h += P.ridgeBaseAmp * ridge;      // 0 by design — see the note on the constant

    // THE SEAMOUNTS — the highs that actually break the surface, warped so each
    // is an island rather than a disc.
    const smWarp = ridgeN.fbm(au * 26 + 5.5, v * 26 + 9.1, 3, 2.2, 0.55);
    for (let i = 0; i < P.seamounts.length; i++) {
      const [sv, sr, sa] = P.seamounts[i];
      // sit each one ON the channel axis at its own latitude
      const axis = distToPath(P.channelAxis, u, v, aspect);
      const dv = v - sv;
      const dsq = Math.hypot(axis.d, dv);
      const rr = sr * (1 + P.seamountWarp * smWarp);
      h += sa * (1 - N.smoothstep(0.25, 1.0, dsq / rr));
    }

    // shallow shelf — CONTINUOUS, so the render feathers instead of drawing a
    // hard-edged box across the channel
    const shelf = inSpan * (1 - N.smoothstep(0.05, 1.30, ch.d / P.shelfHalf));

    // the southern sea, warped so it is a sea and not a lozenge
    const dS = distToPath(P.seaAxis, u, v, aspect).d / (P.seaRadius * (1 + P.seaWarp * sw));
    h -= P.seaDepth * (1 - N.smoothstep(0.35, 1.15, dS));

    // …and its mouth, which reaches into the southern ocean margin
    const dM = distToPath(P.mouth, u, v, aspect).d / (P.mouthRadius * (1 + 0.3 * sw));
    h -= P.mouthDepth * (1 - N.smoothstep(0.3, 1.2, dM));

    // the western gulf
    const dgx = (u - P.gulfCentre[0]) * aspect, dgy = v - P.gulfCentre[1];
    const dG = Math.hypot(dgx, dgy) / (P.gulfRadius * (1 + 0.45 * sw));
    h -= P.gulfDepth * (1 - N.smoothstep(0.3, 1.15, dG));

    return { h, ridge, shelf, chan };
  };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

/* connected components over cells satisfying `pred`, largest first */
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

function classify(order, byKey, thresh) {
  for (const c of order) { c.land = c.h > thresh; c.type = null; }

  // Despeckle land. The floor is SPATIAL: 12 subhexes in open ocean, but 3 on
  // the drowned ridge, where a scatter of small islands is the expected form of
  // a broken land bridge rather than noise. A component is judged by its
  // ridgiest cell, so an island straddling the edge of the ridge is kept.
  for (const m of components(order, byKey, c => c.land).slice(1)) {
    // "inside the channel" — the corridor, not just the crest, so an island
    // sitting just off the ridge line still gets the relaxed floor
    const onRidge = m.some(c => c.shelfF > 0.10 || c.chan > 0.20);
    const floor = onRidge ? P.minIslandRidge : P.minIslandOpen;
    if (m.length < floor) for (const c of m) c.land = false;
  }
  for (const w of components(order, byKey, c => !c.land)) {
    if (w.length < P.minLake) for (const c of w) c.land = true;
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
    const f = field(u, v);
    order.push({
      q: cell.q, r: cell.r, x: cell.x, y: cell.y,
      owner: cell.owner, sub: cell.sub, u, v,
      lat: frame.latOf(v),
      h: f.h, ridge: f.ridge, shelfF: f.shelf, chan: f.chan,
      land: false, type: null, shelf: false,
    });
  }
  const byKey = new Map(order.map(c => [c.q + "," + c.r, c]));

  /* Calibrate against the POST-DESPECKLE fraction: filling specks moves the
   * water fraction, so calibrating on the raw threshold would miss the target. */
  let lo = -3, hi = 3, thresh = 0;
  for (let i = 0; i < 36; i++) {
    thresh = (lo + hi) / 2;
    if (classify(order, byKey, thresh) < P.targetWater) lo = thresh; else hi = thresh;
  }
  thresh = (lo + hi) / 2;
  classify(order, byKey, thresh);

  /* shallow shelf over the drowned ridge (§VII-B). Bathymetry proper comes
   * after approval; this records WHERE the shelf is so it can read it. */
  for (const c of order) if (!c.land && c.shelfF > 0.18) c.shelf = true;

  const masses = components(order, byKey, c => c.land);
  const freshBodies = components(order, byKey, c => c.type === "water");

  const nLand = order.filter(c => c.land).length;
  const nOcean = order.filter(c => c.type === "ocean").length;
  const nFresh = order.filter(c => c.type === "water").length;
  const SQ_MI = 3 * 3 * Math.sqrt(3) / 2;          // area of a 3-mile-across hex

  /* the archipelago: land components sitting on the ridge, excluding the two
   * continental masses themselves */
  const continents = masses.slice(0, 2);
  const isles = masses.filter(m => !continents.includes(m) && m.some(c => c.ridge > 0.12));
  const otherIsles = masses.filter(m => !continents.includes(m) && !isles.includes(m));

  return {
    cells: byKey, order, thresh, params: P,
    masses, isles,
    stats: {
      total: order.length,
      land: nLand, ocean: nOcean, fresh: nFresh,
      waterFraction: (nOcean + nFresh) / order.length,
      landSqMi: Math.round(nLand * SQ_MI),
      frameSqMi: Math.round(order.length * SQ_MI),
      landmasses: masses.map(m => m.length),
      // labelled by CENTROID, not by index: the eastern mass is the larger, so
      // indexing by size silently mislabels them
      continents: continents.map(m => {
        const u = m.reduce((t, c) => t + c.u, 0) / m.length;
        return { side: u < 0.5 ? "west" : "east", cells: m.length,
                 sqMi: Math.round(m.length * SQ_MI), centroidU: Number(u.toFixed(3)) };
      }).sort((a, b) => a.centroidU - b.centroidU),
      archipelago: {
        count: isles.length,
        overThreeHundred: isles.filter(m => m.length * SQ_MI >= 300).length,
        sizesSqMi: isles.map(m => Math.round(m.length * SQ_MI)).sort((a, c) => c - a),
      },
      otherIslands: otherIsles.map(m => Math.round(m.length * SQ_MI)).sort((a, c) => c - a),
      shelfCells: order.filter(c => c.shelf).length,
      freshBodies: freshBodies.map(f => f.length),
    },
  };
}

module.exports = { buildMask, makeField, P };
