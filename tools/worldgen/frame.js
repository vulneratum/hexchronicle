/*
 * The world FRAME — which plates exist, where they sit, and the world subhex
 * lattice they induce. Everything in Phase A samples through here.
 *
 * WORLDGEN §1: 36 plates wide × 36 tall = 1,296 plates, 1,296 miles edge to
 * edge in BOTH directions. §4-A: ids are assigned row-major from the top-left.
 *
 * LAYOUT — offset ("rectangular") axial, not a raw q,r block. A naive block
 * q,r ∈ [0,35] is a rhombus sheared 30°: ~1,890 miles across the top against
 * 1,296 tall, which contradicts §1's "in both directions". Row r therefore
 * spans q ∈ [-floor(r/2), 35-floor(r/2)], which shears the block back upright
 * and gives a genuinely square frame with a half-plate zigzag on the east and
 * west edges.
 *
 * This touches NO frozen geometry (README §2). buildPlateHexes(), PLATE_SPAN
 * and seam ownership all work in RELATIVE (q,r); the frame only decides which
 * absolute (q,r) pairs are in the world.
 */
"use strict";
const G = require("../../shared/geometry.js");

const COLS = 36, ROWS = 36;
const N_PLATES = COLS * ROWS;                     // 1,296

/* row-major id ↔ position (§4-A). col is the offset column, so ids run
 * left-to-right along a visually straight row. */
const colOf = (q, r) => q + Math.floor(r / 2);
const qOf = (col, r) => col - Math.floor(r / 2);
const idOf = (col, r) => String(r * COLS + col + 1).padStart(4, "0");
function posOf(id) {
  const n = parseInt(id, 10) - 1;
  const r = Math.floor(n / COLS), col = n % COLS;
  return { col, r, q: qOf(col, r), r2: r };
}

/* every plate in the frame, in ascending id order */
function plates() {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const q = qOf(col, r);
      out.push({ id: idOf(col, r), col, row: r, q, r });
    }
  }
  return out;
}
const inFrame = (col, r) => col >= 0 && col < COLS && r >= 0 && r < ROWS;

/*
 * THE WORLD SUBHEX LATTICE.
 *
 * A plate at (Q,R) carries its 157 subhexes at world axial
 * (h.q + 12Q, h.r + 12R). Plates OVERLAP at seams — 30 positions per plate are
 * also positions on a neighbour (README §2) — so the union is strictly smaller
 * than 1,296 × 157. WORLDGEN §1's "203,472 subhexes" double-counts those; the
 * true count is computed here and reported.
 *
 * Returns a Map keyed "q,r" → { q, r, x, y, owner, sub }, owner being the
 * lowest-id plate claiming the position, exactly as seam ownership decides.
 */
function subhexLattice() {
  const hexes = G.buildPlateHexes();
  const cells = new Map();
  for (const p of plates()) {
    for (const h of hexes) {
      const q = h.q + G.PLATE_SPAN * p.q, r = h.r + G.PLATE_SPAN * p.r;
      const k = q + "," + r;
      if (cells.has(k)) continue;             // ascending id order ⇒ first claim is the owner
      const px = G.axialToPx(q, r);
      cells.set(k, { q, r, x: px.x, y: px.y, owner: p.id, sub: h.sub });
    }
  }
  return cells;
}

/* World pixel bounds of the frame, from the plate centres plus a plate radius. */
function bounds() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of plates()) {
    const o = G.plateToPx(p.q, p.r);
    if (o.x < minX) minX = o.x;
    if (o.x > maxX) maxX = o.x;
    if (o.y < minY) minY = o.y;
    if (o.y > maxY) maxY = o.y;
  }
  const halfW = G.SQ3 / 2 * G.RL;               // plate half-width across flats
  return { minX: minX - halfW, maxX: maxX + halfW, minY: minY - G.RL, maxY: maxY + G.RL };
}

/*
 * Normalised frame coordinates: u runs 0 (west) → 1 (east), v runs 0 (north)
 * → 1 (south). Latitude is a pure function of v (§1a: 56°N top, 36°N bottom).
 */
const LAT_N = 56, LAT_S = 36;
function project(x, y, b) {
  return { u: (x - b.minX) / (b.maxX - b.minX), v: (y - b.minY) / (b.maxY - b.minY) };
}
const latOf = v => LAT_N - v * (LAT_N - LAT_S);

/* miles per world pixel — a subhex is 3 miles across its flats (SQ3 * SIZE px) */
const MILES_PER_PX = 3 / (G.SQ3 * G.SIZE);

module.exports = {
  COLS, ROWS, N_PLATES, LAT_N, LAT_S, MILES_PER_PX,
  colOf, qOf, idOf, posOf, plates, inFrame, subhexLattice, bounds, project, latOf,
};
