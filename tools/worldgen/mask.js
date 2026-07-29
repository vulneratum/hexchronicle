/*
 * PHASE A, STEP 1 — THE LAND–SEA MASK (WORLDGEN §VII-A, §VII-A2).
 *
 * "The single most consequential call in the project and everything else is
 * downstream of it." Nothing here reads elevation, moisture or drainage; those
 * are computed FROM this, after it is approved (§9).
 *
 * Settled inputs:
 *   - ~40% water; if the ocean ring and channel push past that, the ring wins
 *     and land settles nearer 55%.
 *   - A NORTHERN MASS cut off from the main body by an east–west channel that
 *     is a THROUGH-PASSAGE: open ocean at both ends, so it is salt (rule 14).
 *     It tapers from a wide western mouth to a pinch in the east, and that
 *     pinch is a deliberate chokepoint for Phase D.
 *   - A DROWNED RIDGE at the narrow end carrying an archipelago: the remnant of
 *     the land bridge whose collapse made the split, so the stepping stones and
 *     the chokepoint are one place and the chain has one geological cause
 *     (§VII-B).
 *   - Open water rings the world on all four sides, NEVER less than one plate
 *     and varying between one and five, so the margin is not a rounded
 *     rectangle (rules 11 and 11a).
 *   - ORGANIC COASTLINES: high-frequency octaves injected AT the land–sea
 *     threshold, where they decide the shore at the 3-mile subhex scale, rather
 *     than only the low-frequency noise that shapes the silhouette.
 *
 * The field is continuous and analytic; the subhex lattice merely samples it, so
 * neighbouring plates agree along their seam with no special-casing (§VII).
 */
"use strict";
const N = require("./noise.js");
const frame = require("./frame.js");
const G = require("../../shared/geometry.js");

const MI_PER_PLATE = 36;
const SQ_MI = 3 * 3 * Math.sqrt(3) / 2;      // area of one 3-mile subhex
const EDGE_MI = 3 / Math.sqrt(3);            // length of one shared subhex edge

/* ---- tunables, all recorded in world/constants.yaml ---- */
const P = {
  // The ring wins over the water target. At 0.40 the land expanded until it
  // pressed against the hard one-plate guard along the north and south edges,
  // and the coast collapsed onto that straight contour for 153 miles.
  targetWater: 0.44,

  // ---- silhouette ----
  warpAmp: 0.355,
  warpFreq: 1.55,
  contFreq: 1.95,
  contOctaves: 6,
  contGain: 0.50,
  contAmp: 1.02,
  domeCentre: [0.475, 0.470],
  domeRadius: 0.545,
  domeAmp: 0.44,

  /*
   * ---- the ocean ring (rules 11 and 11a) ----
   *
   * The ring WIDTH is itself a noise field along the perimeter, 1–5 plates, so
   * the margin can never be a traceable contour. Two separate mechanisms:
   *
   *   hard   an unbounded penalty inside one plate of the edge. This alone
   *          guarantees rule 11 and nothing else depends on it.
   *   soft   a gentle quadratic ramp out to the (varying) ring width. Kept weak
   *          on purpose — an earlier version used a strong penalty zeroed past a
   *          FIXED 5.5% inset, and wherever it beat the local noise the shore
   *          collapsed straight onto its contour, which is what made the coast
   *          look machined.
   */
  // Well clear of edgeHardPlates. The hard guard is a cliff at exactly one
  // plate and therefore a RAZOR-STRAIGHT contour; wherever land reached it the
  // coast ran dead straight for 144 miles. The soft ring has to bind first.
  ringMinPlates: 1.85,
  ringMaxPlates: 5.0,
  ringSkew: 1.25,             // >1 biases toward the narrow end ⇒ mean ≈ 2.5–3
  ringFreq: 9.0,              // cycles along each edge
  ringOctaves: 5,             // fine octaves too, so the ring contour wiggles at
                              // the subhex scale and is never traceable
  edgeSoftAmp: 1.70,          // strong enough to bind before the hard guard does
  edgeHardPlates: 1.0,

  /*
   * ---- coastal detail (§VII-A2) ----
   *
   * Injected in a BAND around the threshold rather than everywhere: full
   * strength where the field is near sea level, fading to nothing inland and
   * offshore. Applied globally it would pit the interior with lakes and freckle
   * the deep ocean with islands; applied here it decides the shoreline and only
   * the shoreline. Needs the provisional threshold, so the field is built in
   * two passes (see buildMask).
   */
  detailAmp: 0.88,
  detailFreq: 105.0,          // ≈ 12.5 miles per cycle; octaves reach below one
                              // subhex, which is what breaks straight runs
  detailOctaves: 4,
  detailGain: 0.72,           // high gain ⇒ real energy in the fine octaves
  detailBand: 0.65,           // gaussian width in field units around the threshold
  detailWarpAmp: 0.022,
  detailWarpFreq: 38.0,

  /*
   * ---- the northern channel ----
   *
   * Runs east–west and passes clean through the frame at both ends (u from
   * below 0 to above 1), so it is open ocean to open ocean by construction and
   * cannot come out as a dead-end gulf.
   *
   * Width tapers WEST → EAST: a wide mouth on the Atlantic side, pinching to a
   * chokepoint in the east. Half-widths are in subhexes; a subhex is 3 miles.
   */
  channelAxis: [[-0.06, 0.238], [0.14, 0.262], [0.34, 0.243], [0.52, 0.258],
                [0.70, 0.236], [0.86, 0.250], [1.06, 0.240]],
  channelWideSub: 17,         // half-width at the west mouth ⇒ 34 subhexes across
  channelPinchSub: 4,         // half-width at the east pinch ⇒ 8 subhexes across
  channelDepth: 1.45,
  channelWarp: 0.30,
  channelFineAmp: 0.30,       // high-frequency wobble ON the banks: without it the
  channelFineFreq: 46.0,      // strait has two smooth walls and fails the 6-subhex cap

  /*
   * ---- the drowned ridge and its archipelago ----
   *
   * The swell contributes bathymetry ONLY and never surfaces; discrete
   * seamounts standing on it are the islands. A single continuous crest tuned to
   * just break the surface comes out as a BAR down the middle of the channel.
   *
   * Sited in the narrow EASTERN half. Islands are elongated ALONG the axis,
   * because near the pinch the channel is only a few subhexes wide and a round
   * island of 300 sq mi would dam it.
   */
  ridgeSpan: [0.60, 0.94],    // u range, the narrow end
  ridgeBaseAmp: 0.0,          // bathymetry only — any positive value fuses the chain
  ridgeHalfSub: 3.0,
  shelfHalfSub: 7.5,
  // [u, along-axis radius, across-axis radius, amplitude]
  seamounts: [
    [0.635, 0.030, 0.0085, 1.760],
    [0.694, 0.020, 0.0060, 1.403],
    [0.748, 0.034, 0.0092, 1.843],
    [0.800, 0.017, 0.0055, 1.320],
    [0.845, 0.028, 0.0080, 1.650],
    [0.884, 0.015, 0.0050, 1.265],
    [0.918, 0.022, 0.0068, 1.485],
  ],
  seamountWarp: 0.38,

  // ---- the southern sea (§1a) and the western gulf ----
  // Stops short of the eastern margin on purpose: run out to 0.735 and the
  // sea severs the southern land into a third continent, which is not what
  // was asked for — the split is northern mass versus main body.
  seaAxis: [[0.28, 0.720], [0.40, 0.752], [0.52, 0.760], [0.630, 0.742]],
  seaRadius: 0.132,
  seaDepth: 0.95,
  seaWarp: 0.40,
  mouth: [[0.285, 0.720], [0.245, 0.812], [0.205, 0.900], [0.175, 0.985], [0.160, 1.060]],
  mouthRadius: 0.068,
  mouthDepth: 1.15,
  gulfCentre: [0.105, 0.470],
  gulfRadius: 0.082,
  gulfDepth: 0.58,

  // ---- despeckle ----
  minIslandOpen: 12,
  minIslandChannel: 3,
  minLake: 25,
};

/* smooth minimum-distance to a polyline, in aspect-corrected space.
 * `t` is how far along the path the nearest point lies, 0..1. */
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

function makeField(seed) {
  const warp = N.makeNoise(seed ^ 0x9e3779b9);
  const cont = N.makeNoise(seed);
  const ridgeN = N.makeNoise(seed ^ 0x5bf03635);
  const ringN = N.makeNoise(seed ^ 0x27d4eb2d);
  const detN = N.makeNoise(seed ^ 0x165667b1);
  const b = frame.bounds();
  const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);
  const W_MI = (b.maxX - b.minX) * frame.MILES_PER_PX;
  const H_MI = (b.maxY - b.minY) * frame.MILES_PER_PX;
  const subU = 3 / W_MI, subV = 3 / H_MI;      // one subhex in frame fractions

  /* the ring's width at this point, in miles — a function of position ALONG the
   * nearest edge, so it varies down each side instead of being a fixed inset */
  function ringWidthMi(u, v) {
    const dW = u * W_MI, dE = (1 - u) * W_MI, dN = v * H_MI, dS = (1 - v) * H_MI;
    const d = Math.min(dW, dE, dN, dS);
    let s;                                       // perimeter parameter
    if (d === dW) s = v;
    else if (d === dE) s = 10 + v;
    else if (d === dN) s = 20 + u;
    else s = 30 + u;
    const n = N.clamp01(0.5 + 0.5 * ringN.fbm(s * P.ringFreq, 7.3, P.ringOctaves, 2.1, 0.55));
    const skewed = Math.pow(n, P.ringSkew);
    return { d, mi: (P.ringMinPlates + (P.ringMaxPlates - P.ringMinPlates) * skewed) * MI_PER_PLATE };
  }

  /* everything except the coastal detail — pass one */
  function base(u, v) {
    const au = u * aspect;
    const wx = warp.fbm(au * P.warpFreq, v * P.warpFreq, 4);
    const wy = warp.fbm(au * P.warpFreq + 31.7, v * P.warpFreq + 17.3, 4);
    const su = au + P.warpAmp * wx, sv = v + P.warpAmp * wy;

    const ddx = su - P.domeCentre[0] * aspect, ddy = sv - P.domeCentre[1];
    const dr = Math.hypot(ddx, ddy) / P.domeRadius;
    let h = P.domeAmp * (1 - dr * dr)
          + P.contAmp * cont.fbm(su * P.contFreq, sv * P.contFreq, P.contOctaves, 2.0, P.contGain);

    // the ring: a weak soft ramp out to the varying width, plus a hard floor
    const { d, mi } = ringWidthMi(u, v);
    h -= P.edgeSoftAmp * Math.pow(N.clamp01(1 - d / mi), 2);
    if (d < P.edgeHardPlates * MI_PER_PLATE) {
      h -= 60 * (1 - d / (P.edgeHardPlates * MI_PER_PLATE)) + 6;
    }

    const sw = warp.fbm(au * 3.4 + 11.7, v * 3.4 + 4.4, 3);

    // the northern channel: half-width tapers west (wide) → east (pinch)
    const ch = distToPath(P.channelAxis, u, v, aspect);
    const halfSub = N.lerp(P.channelWideSub, P.channelPinchSub, N.clamp01(ch.t));
    const chFine = ridgeN.fbm(u * P.channelFineFreq, v * P.channelFineFreq * 0.5, 3, 2.2, 0.55);
    const half = halfSub * subV * (1 + P.channelWarp * sw + P.channelFineAmp * chFine);
    const chan = 1 - N.smoothstep(0.60, 1.30, ch.d / half);
    h -= P.channelDepth * chan;

    // the drowned ridge — bathymetry only
    const inSpan = N.smoothstep(P.ridgeSpan[0] - 0.06, P.ridgeSpan[0] + 0.02, u)
                 * (1 - N.smoothstep(P.ridgeSpan[1] - 0.02, P.ridgeSpan[1] + 0.06, u));
    const ridge = inSpan * (1 - N.smoothstep(0.30, 1.0, ch.d / (P.ridgeHalfSub * subV)));
    h += P.ridgeBaseAmp * ridge;
    const shelf = inSpan * (1 - N.smoothstep(0.05, 1.30, ch.d / (P.shelfHalfSub * subV)));

    // the seamounts — elongated along the channel so they fit the pinch
    const smWarp = ridgeN.fbm(au * 26 + 5.5, v * 26 + 9.1, 3, 2.2, 0.55);
    for (let i = 0; i < P.seamounts.length; i++) {
      const [su0, ra, rb, sa] = P.seamounts[i];
      const dAlong = (u - su0) / (ra * (1 + P.seamountWarp * smWarp));
      const dAcross = ch.d / (rb * (1 + P.seamountWarp * smWarp));
      h += sa * (1 - N.smoothstep(0.25, 1.0, Math.hypot(dAlong, dAcross)));
    }

    // southern sea, its mouth, and the western gulf
    const dS = distToPath(P.seaAxis, u, v, aspect).d / (P.seaRadius * (1 + P.seaWarp * sw));
    h -= P.seaDepth * (1 - N.smoothstep(0.35, 1.15, dS));
    const dM = distToPath(P.mouth, u, v, aspect).d / (P.mouthRadius * (1 + 0.3 * sw));
    h -= P.mouthDepth * (1 - N.smoothstep(0.3, 1.2, dM));
    const dgx = (u - P.gulfCentre[0]) * aspect, dgy = v - P.gulfCentre[1];
    const dG = Math.hypot(dgx, dgy) / (P.gulfRadius * (1 + 0.45 * sw));
    h -= P.gulfDepth * (1 - N.smoothstep(0.3, 1.15, dG));

    return { h, ridge, shelf, chan, edgeMi: d, ringMi: mi };
  }

  /*
   * The coastal detail (§VII-A2) — pass two. Domain-warped high-frequency fbm,
   * weighted by a gaussian in |h0 - thresh| so it bites only where the shore
   * actually is. This is what puts structure at the subhex scale; without it the
   * silhouette is organic but the shoreline itself runs in long clean arcs.
   */
  function detail(u, v, h0, thresh) {
    const au = u * aspect;
    const dwx = detN.fbm(au * P.detailWarpFreq, v * P.detailWarpFreq, 2);
    const dwy = detN.fbm(au * P.detailWarpFreq + 13.1, v * P.detailWarpFreq + 7.7, 2);
    const du = au + P.detailWarpAmp * dwx, dv = v + P.detailWarpAmp * dwy;
    const n = detN.fbm(du * P.detailFreq, dv * P.detailFreq,
      P.detailOctaves, 2.15, P.detailGain);
    const z = (h0 - thresh) / P.detailBand;
    return P.detailAmp * n * Math.exp(-z * z);
  }

  return { base, detail, ringWidthMi, aspect, W_MI, H_MI, subU, subV };
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

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

  // Despeckle. The floor is SPATIAL: 3 subhexes inside the channel, where a
  // scatter of small islands is the expected form of a broken land bridge, and
  // 12 in open ocean, where a speck has no cause (§VII-B).
  for (const m of components(order, byKey, c => c.land).slice(1)) {
    const inChannel = m.some(c => c.chan > 0.20 || c.shelfF > 0.10);
    if (m.length < (inChannel ? P.minIslandChannel : P.minIslandOpen)) {
      for (const c of m) c.land = false;
    }
  }
  for (const w of components(order, byKey, c => !c.land)) {
    if (w.length < P.minLake) for (const c of w) c.land = true;
  }

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

function calibrate(order, byKey, target) {
  let lo = -8, hi = 8, t = 0;
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2;
    if (classify(order, byKey, t) < target) lo = t; else hi = t;
  }
  return (lo + hi) / 2;
}

/* ============================================================= *
 * COASTLINE METRICS (§VII-A2, validation rule 11a)
 * ============================================================= */

/* Shoreline development index: coastline length over the circumference of a
 * circle of equal area. A perfect disc is 1.0; a deeply indented coast is 3+. */
function shorelineMetrics(mass, byKey) {
  let edges = 0;
  for (const c of mass) {
    for (const [dq, dr] of DIRS) {
      const n = byKey.get((c.q + dq) + "," + (c.r + dr));
      if (!n || !n.land) edges++;        // the frame edge counts as coast too
    }
  }
  const lengthMi = edges * EDGE_MI;
  const areaSqMi = mass.length * SQ_MI;
  return { edges, lengthMi, areaSqMi, sdi: lengthMi / (2 * Math.sqrt(Math.PI * areaSqMi)) };
}

/* the six neighbours in CYCLIC order — required for a boundary walk, unlike
 * DIRS, which is a set and not a rotation */
const CYC = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

/*
 * The longest run the SHORELINE advances in one hex direction. §VII-A2 caps it
 * at 6 subhexes (18 miles): a coast that runs further than that in one direction
 * is a machined edge, not a shore.
 *
 * This walks the land/water boundary as an ordered contour and measures runs of
 * identical consecutive cell-to-cell steps. An earlier version instead scanned
 * for contiguous COASTAL CELLS along each axis, which measures the wrong thing
 * entirely: a deeply crinkled coast has a wide band of coastal cells, and any
 * line drawn through that band crosses dozens of them in a row while the
 * shoreline itself never runs straight for more than two or three.
 *
 * Walk rule, verified against a lone hex (6 edges) and a domino (10 edges):
 * from (cell, k) where side k faces water, try nk = k+1; if that side is also
 * water the contour turns in place, otherwise it steps onto that land neighbour
 * and re-enters at side nk+4.
 */
function axisRuns(order, byKey, limit) {
  const isLand = (q, r) => { const c = byKey.get(q + "," + r); return !!(c && c.land); };
  const visited = new Set();
  let worst = 0, contours = 0;
  const offenders = [];

  for (const start of order) {
    if (!start.land) continue;
    for (let k0 = 0; k0 < 6; k0++) {
      if (isLand(start.q + CYC[k0][0], start.r + CYC[k0][1])) continue;
      if (visited.has(start.q + "," + start.r + "," + k0)) continue;

      const steps = [];                    // { dir, cell } per cell-to-cell move
      let cell = start, k = k0, guard = 0;
      do {
        visited.add(cell.q + "," + cell.r + "," + k);
        const nk = (k + 1) % 6, d = CYC[nk];
        const nq = cell.q + d[0], nr = cell.r + d[1];
        if (!isLand(nq, nr)) {
          k = nk;                          // turn in place
        } else {
          cell = byKey.get(nq + "," + nr);
          k = (nk + 4) % 6;
          steps.push({ dir: nk, cell });
        }
      } while (!(cell === start && k === k0) && ++guard < 2000000);
      contours++;

      if (steps.length < 3) continue;
      // runs, wrapping once around so a run straddling the seam is not split
      let run = 1, best = 1, bestCell = steps[0].cell, bestDir = steps[0].dir;
      for (let i = 1; i < steps.length + Math.min(steps.length, 64); i++) {
        const a = steps[i % steps.length], b = steps[(i - 1) % steps.length];
        if (a.dir === b.dir) {
          run++;
          if (run > best) { best = run; bestCell = a.cell; bestDir = a.dir; }
        } else run = 1;
      }
      if (best > worst) worst = best;
      if (best > limit) offenders.push({ len: best, cell: bestCell, dir: CYC[bestDir] });
    }
  }
  offenders.sort((a, b) => b.len - a.len);
  return { worst, offenders, contours };
}

/*
 * Ring width around the whole frame: from many points on the perimeter, march
 * inward until land. Reported in PLATES, because rule 11 is stated in plates and
 * 11a needs to see that the width actually varies.
 */
function ringProfile(byKey, geom, samples) {
  samples = samples || 800;
  const b = frame.bounds();
  const widths = [];
  const probe = (u0, v0, du, dv) => {
    for (let step = 1; step < 500; step++) {
      const t = step * 0.002;
      const u = u0 + du * t, v = v0 + dv * t;
      if (u < 0 || u > 1 || v < 0 || v > 1) break;
      const x = b.minX + u * (b.maxX - b.minX), y = b.minY + v * (b.maxY - b.minY);
      const a = G.pxToAxial(x, y);
      const cell = byKey.get(a.q + "," + a.r);
      if (cell && cell.land) {
        return Math.hypot(du * t * geom.W_MI, dv * t * geom.H_MI) / MI_PER_PLATE;
      }
    }
    return null;                                // no land along this ray at all
  };
  const per = Math.floor(samples / 4);
  for (let i = 0; i < per; i++) {
    const t = (i + 0.5) / per;
    let w;
    if ((w = probe(0, t, 1, 0)) !== null) widths.push(w);
    if ((w = probe(1, t, -1, 0)) !== null) widths.push(w);
    if ((w = probe(t, 0, 0, 1)) !== null) widths.push(w);
    if ((w = probe(t, 1, 0, -1)) !== null) widths.push(w);
  }
  // A ray fired into the mouth of a strait or the southern sea travels a long
  // way before finding land. That is an OPENING, not margin, and averaging it
  // into the ring statistics would hide what the margin actually does.
  const OPENING = 8;
  const margin = widths.filter(w => w <= OPENING).sort((a, c) => a - c);
  const openings = widths.filter(w => w > OPENING).length;
  const mean = margin.reduce((s, x) => s + x, 0) / margin.length;
  const sd = Math.sqrt(margin.reduce((s, x) => s + (x - mean) * (x - mean), 0) / margin.length);
  return {
    n: widths.length, marginRays: margin.length, openingRays: openings,
    min: Number(margin[0].toFixed(2)),
    max: Number(margin[margin.length - 1].toFixed(2)),
    mean: Number(mean.toFixed(2)), sd: Number(sd.toFixed(2)),
    p10: Number(margin[Math.floor(margin.length * 0.1)].toFixed(2)),
    p50: Number(margin[Math.floor(margin.length * 0.5)].toFixed(2)),
    p90: Number(margin[Math.floor(margin.length * 0.9)].toFixed(2)),
  };
}

/* ============================================================= *
 * BUILD
 * ============================================================= */
function buildMask(seed) {
  const F = makeField(seed);
  const b = frame.bounds();
  const lattice = frame.subhexLattice();

  const order = [];
  for (const cell of lattice.values()) {
    const { u, v } = frame.project(cell.x, cell.y, b);
    const f = F.base(u, v);
    order.push({
      q: cell.q, r: cell.r, x: cell.x, y: cell.y,
      owner: cell.owner, sub: cell.sub, u, v,
      lat: frame.latOf(v),
      h0: f.h, h: f.h, ridge: f.ridge, shelfF: f.shelf, chan: f.chan,
      edgeMi: f.edgeMi, ringMi: f.ringMi,
      land: false, type: null, shelf: false,
    });
  }
  const byKey = new Map(order.map(c => [c.q + "," + c.r, c]));

  /* PASS ONE — a provisional threshold from the silhouette alone. The coastal
   * detail is weighted by distance from this, so it has to exist first. */
  const thresh0 = calibrate(order, byKey, P.targetWater);

  /* PASS TWO — inject the detail, then recalibrate. */
  for (const c of order) c.h = c.h0 + F.detail(c.u, c.v, c.h0, thresh0);
  const thresh = calibrate(order, byKey, P.targetWater);

  for (const c of order) c.shelf = !c.land && c.shelfF > 0.18;

  const masses = components(order, byKey, c => c.land);
  const freshBodies = components(order, byKey, c => c.type === "water");

  const nLand = order.filter(c => c.land).length;
  const nOcean = order.filter(c => c.type === "ocean").length;
  const nFresh = order.filter(c => c.type === "water").length;

  // A landmass of 30,000 sq mi is Ireland; calling it part of an archipelago
  // because it happens to touch the channel is a reporting lie. Continents are
  // anything substantial; the chain is what sits ON the drowned ridge.
  const continents = masses.filter(m => m.length * SQ_MI > 20000);
  const isles = masses.filter(m => !continents.includes(m)
    && m.some(c => c.shelfF > 0.10 || c.chan > 0.20));
  const otherIsles = masses.filter(m => !continents.includes(m) && !isles.includes(m));

  const massStats = continents.map(m => {
    const sm = shorelineMetrics(m, byKey);
    const u = m.reduce((t, c) => t + c.u, 0) / m.length;
    const v = m.reduce((t, c) => t + c.v, 0) / m.length;
    return {
      cells: m.length, sqMi: Math.round(sm.areaSqMi),
      coastMi: Math.round(sm.lengthMi), sdi: Number(sm.sdi.toFixed(2)),
      centroid: [Number(u.toFixed(3)), Number(v.toFixed(3))],
      name: v < 0.34 ? "northern" : "main",
    };
  }).sort((a, c) => a.centroid[1] - c.centroid[1]);

  const runs = axisRuns(order, byKey, 6);
  const ring = ringProfile(byKey, F);

  return {
    cells: byKey, order, thresh, thresh0, params: P, masses, isles, field: F, runs,
    stats: {
      total: order.length,
      land: nLand, ocean: nOcean, fresh: nFresh,
      waterFraction: (nOcean + nFresh) / order.length,
      landSqMi: Math.round(nLand * SQ_MI),
      frameSqMi: Math.round(order.length * SQ_MI),
      landmasses: masses.map(m => m.length),
      continents: massStats,
      archipelago: {
        count: isles.length,
        overThreeHundred: isles.filter(m => m.length * SQ_MI >= 300).length,
        sizesSqMi: isles.map(m => Math.round(m.length * SQ_MI)).sort((a, c) => c - a),
      },
      otherIslands: otherIsles.map(m => Math.round(m.length * SQ_MI)).sort((a, c) => c - a),
      shelfCells: order.filter(c => c.shelf).length,
      freshBodies: freshBodies.map(f => f.length),
      coastRuns: { worst: runs.worst, over: runs.offenders.length },
      ring,
    },
  };
}

module.exports = { buildMask, makeField, components, shorelineMetrics, axisRuns,
                   ringProfile, P, DIRS, SQ_MI, EDGE_MI, MI_PER_PLATE };
