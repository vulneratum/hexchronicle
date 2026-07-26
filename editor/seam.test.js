#!/usr/bin/env node
/*
 * Seam ownership tests (shared/geometry.js).
 *
 * Hexagons do not tile into larger hexagons. A plate is 12 subhexes across, so
 * its boundary runs exactly THROUGH a line of subhex centres and both adjacent
 * plates contain them. That is a fact of the geometry, not a bug to fix — the
 * numbering is frozen (README §2) — so the fix is an OWNERSHIP layer: the
 * lower-numbered plate owns a shared position, and everything reads and writes
 * through the owner.
 *
 * What is asserted here is the part that must never drift:
 *   - exactly 5 shared positions per edge, 30 per plate, symmetric
 *   - the pairings are exact lattice matches, not near misses
 *   - both directions agree on ONE owner
 *   - every shared position is exactly equidistant from both plate centres,
 *     which is why README §2's "nearest centre, ties to the lower number"
 *     reduces to the tie-break alone
 *   - no interior hex is affected, and nothing is renumbered
 */
"use strict";
const HexGeo = require("../shared/geometry.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok  " : "  NOT OK  ") + msg);
  cond ? pass++ : fail++;
}

const geo = HexGeo.buildPlateHexes();
const bySub = new Map(geo.map(h => [h.sub, h]));
const byKey = new Map(geo.map(h => [h.q + "," + h.r, h]));
const DIRS = HexGeo.PLATE_DIR;

console.log("the seam itself:");

/* ---- 1. the numbering is untouched ---- */
{
  ok(geo.length === 157, `a plate is still ${geo.length} subhexes`);
  ok(geo[0].sub === "001" && geo[156].sub === "157", "still numbered 001..157, row by row");
  ok(HexGeo.PLATE_SPAN === 12, "a plate offset is exactly 12 subhex steps");
  // the plate lattice and the subhex lattice really are the same lattice
  const a = HexGeo.plateToPx(1, 0), b = HexGeo.axialToPx(12, 0);
  const c = HexGeo.plateToPx(0, 1), d = HexGeo.axialToPx(0, 12);
  ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9 && Math.hypot(c.x - d.x, c.y - d.y) < 1e-9,
    "…so a plate step lands exactly on subhex lattice points — the duplicates coincide");
}

/* ---- 2. five shared positions on every edge, thirty per plate ---- */
{
  let total = 0, worstOffset = 0;
  const perEdge = {};
  for (const [dir, [dq, dr]] of Object.entries(DIRS)) {
    const shared = [];
    for (const h of geo) {
      const other = byKey.get((h.q - HexGeo.PLATE_SPAN * dq) + "," + (h.r - HexGeo.PLATE_SPAN * dr));
      if (!other) continue;
      shared.push([h.sub, other.sub]);
      // exact, not approximate: same world point to the last bit of the maths
      const mine = HexGeo.axialToPx(h.q, h.r);
      const off = HexGeo.plateToPx(dq, dr), theirs = HexGeo.axialToPx(other.q, other.r);
      worstOffset = Math.max(worstOffset, Math.hypot(mine.x - (theirs.x + off.x), mine.y - (theirs.y + off.y)));
    }
    perEdge[dir] = shared;
    total += shared.length;
  }
  ok(Object.values(perEdge).every(s => s.length === 5),
    "exactly 5 positions are shared across every one of the six edges");
  ok(total === 30, `30 shared positions per plate (got ${total})`);
  ok(worstOffset < 1e-9, `the lattices align exactly — worst mismatch ${worstOffset.toExponential(1)} px, not a near miss`);

  // the pairings are symmetric: what I share with my SE neighbour, it shares
  // with its NW neighbour, the same pairs read the other way round
  const se = perEdge.se.map(p => p.join("=")).sort();
  const nw = perEdge.nw.map(p => [p[1], p[0]].join("=")).sort();
  ok(se.join(" ") === nw.join(" "), "the SE and NW seams are the same five pairs, mirrored");

  // the measured pairings, written down so a change to them cannot pass quietly
  ok(perEdge.se.map(p => p.join("=")).join(" ") === "135=001 145=002 152=006 156=013 157=023",
    "across the SE seam: 135/145/152/156/157 are the neighbour's 001/002/006/013/023");
}

/* ---- 3. every shared position is EXACTLY equidistant from both centres ---- */
{
  let worst = 0;
  for (const [dir, [dq, dr]] of Object.entries(DIRS)) {
    const off = HexGeo.plateToPx(dq, dr);
    for (const h of geo) {
      if (!byKey.get((h.q - HexGeo.PLATE_SPAN * dq) + "," + (h.r - HexGeo.PLATE_SPAN * dr))) continue;
      const p = HexGeo.axialToPx(h.q, h.r);
      const dMine = Math.hypot(p.x, p.y);
      const dTheirs = Math.hypot(p.x - off.x, p.y - off.y);
      worst = Math.max(worst, Math.abs(dMine - dTheirs));
    }
  }
  // The shared edge IS the perpendicular bisector of the two plate centres, so
  // this is not luck — no shared position can ever be nearer one parent.
  ok(worst < 1e-9,
    `every shared position is exactly equidistant from both plate centres (worst gap ${worst.toExponential(1)} px) — a pure tie, so only the id breaks it`);
}

console.log("ownership:");

/* a plausible little map: 0001 at the origin, 0002 east, 0003 south-east */
const LATTICE = { "0001": [0, 0], "0002": [1, 0], "0003": [0, 1] };
const own = HexGeo.plateOwnership(LATTICE);

/* ---- 4. both directions resolve to ONE owner ---- */
{
  // 0001's east seam is 0002's west seam
  const pairs = [["035", "023"], ["060", "048"], ["085", "073"], ["110", "098"], ["135", "123"]];
  let agree = 0;
  for (const [mine, theirs] of pairs) {
    const a = own.ownerOf("0001", mine), b = own.ownerOf("0002", theirs);
    if (a.plateId === b.plateId && a.sub === b.sub) agree++;
  }
  ok(agree === pairs.length,
    "0001/0002: all five shared positions resolve to the same single owner from both sides");
  ok(pairs.every(([mine]) => {
    const o = own.ownerOf("0001", mine);
    return o.plateId === "0001" && o.sub === mine;
  }), "…and the owner is 0001, the lower id — it keeps its own numbers");
  ok(pairs.every(([, theirs]) => own.isBorrowed("0002", theirs)),
    "…while 0002 merely borrows them");
}

/* ---- 5. THE CASE FROM THE FIELD: 0003-135 is 0002-001 ---- *
 * With 0002 east of 0001 and 0003 south-east, 0003 sits south-west of 0002:
 * 0003's SE-seam numbers are 0002's NW-seam numbers. The physical hex must have
 * ONE identity, and it must be 0003's, because 0003 < … no: the lower id wins,
 * and here that is 0002. The direction of the rule is what is asserted, not a
 * remembered answer. */
{
  const lattice2 = { "0002": [0, 0], "0003": [0, 1] };     // 0003 south-east of 0002
  const o2 = HexGeo.plateOwnership(lattice2);
  const a = o2.ownerOf("0002", "135"), b = o2.ownerOf("0003", "001");
  ok(a.plateId === b.plateId && a.sub === b.sub,
    `0002-135 and 0003-001 are one hex: both resolve to ${a.plateId}-${a.sub}`);
  ok(a.plateId === "0002" && a.sub === "135",
    "…owned by 0002, the lower id — created first, so it keeps the address");
  ok(o2.addressOf("0003", "001") === "0002-135",
    "the address shown on plate 0003 for that hex is 0002-135, not 0003-001");
  ok(!o2.isBorrowed("0002", "135") && o2.isBorrowed("0003", "001"),
    "exactly one of the two plates owns it");
}

/* ---- 6. the boundary, and nothing but the boundary ---- */
{
  // a plate fully ringed by lower-numbered neighbours borrows its whole rim
  const ring = { "0009": [0, 0] };
  let i = 1;
  for (const [, [dq, dr]] of Object.entries(DIRS)) ring["000" + i++] = [dq, dr];
  const o = HexGeo.plateOwnership(ring);
  const borrowed = o.borrowedSubs("0009");
  // 5 per edge × 6 edges = 30 slots, but the six CORNERS each sit on two edges,
  // so 24 distinct positions — which is also why a corner has three claimants
  ok(borrowed.length === 24,
    `the 30 edge slots are 24 distinct positions, the six corners being shared twice (got ${borrowed.length})`);
  ok(borrowed.filter(s => o.sharersOf("0009", s).length === 3).length === 6,
    "…and exactly six of them are corners, claimed by three plates each");
  ok(o.borrowedSubs("0001").length === 0, "the lowest id in the group borrows nothing");

  // an interior hex is never touched, whatever the map looks like
  const seam = new Set(borrowed);
  const interior = geo.filter(h => !seam.has(h.sub));
  ok(interior.length === 133, `133 interior positions are untouched (${interior.length})`);
  ok(interior.every(h => o.ownerOf("0009", h.sub).plateId === "0009" && o.ownerOf("0009", h.sub).sub === h.sub),
    "every interior hex still belongs to its own plate, under its own unchanged number");
}

/* ---- 7. a corner belongs to three plates, and still has one owner ---- */
{
  // 0001's 023 corner is shared with its W and NW neighbours
  const corner = { "0001": [0, 0], "0004": [-1, 0], "0005": [0, -1] };
  const o = HexGeo.plateOwnership(corner);
  const sharers = o.sharersOf("0001", "023");
  ok(sharers.length === 3, `a corner position is claimed by three plates (got ${sharers.length})`);
  ok(sharers[0].plateId === "0001", "the owner is listed first, and it is the lowest id");
  ok(new Set(sharers.map(c => o.addressOf(c.plateId, c.sub))).size === 1,
    "all three agree on the one address");
}

/* ---- 8. ownership is stable as the map grows ---- */
{
  const before = HexGeo.plateOwnership({ "0001": [0, 0], "0002": [1, 0] });
  const after = HexGeo.plateOwnership({ "0001": [0, 0], "0002": [1, 0], "0003": [0, 1], "0004": [1, -1] });
  const same = geo.every(h =>
    before.addressOf("0002", h.sub) === after.addressOf("0002", h.sub) ||
    // positions that had no other claimant may gain one, but only from a HIGHER
    // id, which cannot take ownership
    after.ownerOf("0002", h.sub).plateId === "0002");
  ok(same, "adding plates never moves an existing hex's ownership — new ids are always higher");

  // the origin of the lattice is irrelevant: only relative position matters
  const shifted = HexGeo.plateOwnership({ "0001": [5, -3], "0002": [6, -3], "0003": [5, -2] });
  ok(geo.every(h => shifted.addressOf("0002", h.sub) === own.addressOf("0002", h.sub)),
    "shifting the whole lattice changes nothing — ownership is relative, never stored");
}

/* ---- 9. an unplaced plate owns itself ---- */
{
  const o = HexGeo.plateOwnership({ "0001": [0, 0] });
  ok(o.ownerOf("0007", "001").plateId === "0007",
    "a plate that is not on the lattice borrows from nobody");
  ok(o.borrowedSubs("0001").length === 0, "a lone plate owns all 157 of its positions");
}

console.log(`\n${pass} checks passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
