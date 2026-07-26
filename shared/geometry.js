/*
 * HexChronicle plate geometry — the single source of truth for subhex
 * positions and numbering. Loaded by the Node build (via require) AND inlined
 * into the browser renderer, so both sides compute the exact same layout.
 *
 * Three nested 12-across scales (README §2). This module handles one plate:
 * a point-up atlas hexagon tiled with pointy-top subhexes, numbered row by
 * row top-left -> bottom-right (README §2 addressing), giving addresses
 * 0001-001 ... 0001-NNN.
 */
(function (global) {
  "use strict";

  const SQ3 = Math.sqrt(3);
  const SIZE = 26;            // subhex circumradius in px
  const RL = 12 * SIZE;       // plate circumradius: 12 subhexes across the flats

  const axialToPx = (q, r) => ({ x: SQ3 * SIZE * (q + r / 2), y: 1.5 * SIZE * r });

  function pxToAxial(x, y) {
    const q = (SQ3 / 3 * x - y / 3) / SIZE, r = (2 / 3 * y) / SIZE;
    const sf = -q - r;
    let qq = Math.round(q), rr = Math.round(r), ss = Math.round(sf);
    const dq = Math.abs(qq - q), dr = Math.abs(rr - r), ds = Math.abs(ss - sf);
    if (dq > dr && dq > ds) qq = -rr - ss; else if (dr > ds) rr = -qq - ss;
    return { q: qq, r: rr };
  }

  function hexCorners(cx, cy, size) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI / 180 * (60 * k - 30);
      pts.push((cx + size * Math.cos(ang)).toFixed(2) + "," + (cy + size * Math.sin(ang)).toFixed(2));
    }
    return pts.join(" ");
  }

  function plateCorners(size) {            // point-up big hexagon
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI / 180 * (60 * k + 30);
      pts.push((size * Math.cos(ang)).toFixed(2) + "," + (size * Math.sin(ang)).toFixed(2));
    }
    return pts.join(" ");
  }

  const insidePlate = (x, y, R) => {
    const dx = Math.abs(x), dy = Math.abs(y);
    return dx <= SQ3 / 2 * R + 0.01 && dy <= R - dx / SQ3 + 0.01;
  };

  /*
   * The canonical subhex set for a plate, numbered 1..N. Deterministic:
   * change this and every existing address would shift, so it is frozen
   * (README §2 — renumbering is forbidden). Returns objects with axial coords
   * (q,r), pixel center (x,y), the padded subhex number "NNN", and 1-based num.
   */
  function buildPlateHexes() {
    const list = [];
    for (let q = -16; q <= 16; q++) for (let r = -16; r <= 16; r++) {
      const px = axialToPx(q, r);
      if (!insidePlate(px.x, px.y, RL)) continue;
      list.push({ q, r, x: px.x, y: px.y, key: q + "," + r });
    }
    // row by row, top-left to bottom-right
    list.sort((a, b) => a.r - b.r || a.x - b.x);
    list.forEach((h, i) => {
      h.num = i + 1;
      h.sub = String(i + 1).padStart(3, "0");
    });
    return list;
  }

  const neighborDirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

  /*
   * The PLATE lattice. Plates tile the same way subhexes do, one scale up, so
   * the axial convention is identical: `e` is [1,0], `se` is [0,1], and so on.
   * plateToPx gives a plate's centre offset from the origin plate, which is what
   * lets one plate draw something positioned on another.
   */
  const PLATE_DIR = { e: [1, 0], se: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [0, -1], ne: [1, -1] };
  const plateToPx = (q, r) => ({ x: SQ3 * RL * (q + r / 2), y: 1.5 * RL * r });

  /*
   * Subhex addresses (README §2). "023" is shorthand for "subhex 023 of whatever
   * plate is being talked about"; "0002-023" is the full permanent address and
   * means the same hex no matter who is reading it. Anywhere a path may leave
   * its own plate — a road crossing a boundary — the qualified form is required.
   * Returns { plate: "0002"|null, sub: "023" }, or null if it is not an address.
   */
  const ADDR_RE = /^(?:(\d{4})-)?(\d{3})$/;
  function parseAddr(entry) {
    const m = ADDR_RE.exec(String(entry == null ? "" : entry).trim());
    return m ? { plate: m[1] || null, sub: m[2] } : null;
  }
  // Resolve a path entry to its full address, given the plate that owns the path.
  function fullAddr(entry, ownerPlateId) {
    const a = parseAddr(entry);
    return a ? (a.plate || ownerPlateId) + "-" + a.sub : null;
  }

  /* ============================================================= *
   * SEAM OWNERSHIP — one physical hex, one identity
   *
   * Hexagons do not tile into larger hexagons. A plate is 12 subhexes across,
   * so its boundary runs exactly THROUGH a line of subhex centres rather than
   * between them, and insidePlate()'s tolerance lets both neighbours claim them.
   * Measured, not assumed: 5 positions on every edge, 30 per plate, and the
   * lattices align exactly — a plate offset is precisely 12 subhex steps, so the
   * duplicates are the SAME lattice point, not a near miss. A corner position is
   * claimed by three plates.
   *
   *   plate (dq,dr)  ->  subhex offset (12dq, 12dr)      PLATE_SPAN below
   *
   * Every shared position is exactly equidistant from the claiming plates'
   * centres — they are all at distance RL — so README §2's "nearest parent
   * centre, ties to the lower number" reduces entirely to the tie-break: the
   * plate with the LOWER numeric id, the one created first, owns it.
   *
   * Ownership is therefore derivable from POSITION ALONE and never stored, and
   * it is stable as the map grows: plate ids are handed out in creation order,
   * so a new plate always has the highest id and can never take a seam from an
   * existing one.
   *
   * The numbering itself is untouched (README §2 forbids renumbering): all 157
   * subhexes still exist on every plate. This is an ownership layer on top —
   * a borrowed position is still addressable as "0002-001", it just resolves to
   * "0003-135" for everything that reads or writes it.
   * ============================================================= */
  const PLATE_SPAN = 12;

  /*
   * Build the ownership index for a set of plates at known lattice coords —
   * `{ "0001": [q,r], … }` or a Map of the same. Coordinates may be relative to
   * any origin: ownership compares positions with each other, so shifting the
   * whole lattice changes nothing.
   */
  function plateOwnership(plateCoords) {
    const entries = (plateCoords instanceof Map ? [...plateCoords] : Object.entries(plateCoords || {}))
      .filter(e => Array.isArray(e[1]))
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));   // lower id first
    const coords = new Map(entries);
    const hexes = buildPlateHexes();
    const bySub = new Map(hexes.map(h => [h.sub, h]));

    // every claim on every position; the entries are in ascending id order, so
    // the FIRST claim on a position is the canonical one
    const claims = new Map();                     // world key -> [{ plateId, sub }, …]
    for (const [id, c] of entries) {
      for (const h of hexes) {
        const k = (h.q + PLATE_SPAN * c[0]) + "," + (h.r + PLATE_SPAN * c[1]);
        const list = claims.get(k);
        if (list) list.push({ plateId: id, sub: h.sub });
        else claims.set(k, [{ plateId: id, sub: h.sub }]);
      }
    }

    /* the world lattice position of one subhex, or null if the plate is not placed */
    function worldKey(plateId, sub) {
      const c = coords.get(plateId), h = bySub.get(sub);
      if (!c || !h) return null;
      return (h.q + PLATE_SPAN * c[0]) + "," + (h.r + PLATE_SPAN * c[1]);
    }

    /*
     * The canonical identity of a hex. Falls back to the address as given when
     * the plate is not on this lattice — an unplaced plate borrows from nobody,
     * so answering "itself" is both safe and true.
     */
    function ownerOf(plateId, sub) {
      const k = worldKey(plateId, sub);
      const list = k && claims.get(k);
      return (list && list[0]) || { plateId, sub };
    }
    /*
     * EVERY plate that shows this position, owner first — up to three at a
     * corner. One physical hex has one value, so an edit has to reach all of
     * them, even though only the owner's file is written.
     */
    function sharersOf(plateId, sub) {
      const k = worldKey(plateId, sub);
      return (k && claims.get(k)) || [{ plateId, sub }];
    }
    const isBorrowed = (plateId, sub) => ownerOf(plateId, sub).plateId !== plateId;
    const addressOf = (plateId, sub) => {
      const o = ownerOf(plateId, sub);
      return o.plateId + "-" + o.sub;
    };
    /* every subhex of `plateId` that belongs to somebody else */
    function borrowedSubs(plateId) {
      const out = [];
      for (const h of hexes) if (isBorrowed(plateId, h.sub)) out.push(h.sub);
      return out;
    }

    return {
      coords, worldKey, ownerOf, sharersOf, isBorrowed, addressOf, borrowedSubs,
      placed: id => coords.has(id),
    };
  }

  const HexGeo = {
    SQ3, SIZE, RL, PLATE_SPAN,
    axialToPx, pxToAxial, hexCorners, plateCorners, insidePlate,
    buildPlateHexes, neighborDirs,
    PLATE_DIR, plateToPx, parseAddr, fullAddr, plateOwnership,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = HexGeo;
  else global.HexGeo = HexGeo;
})(typeof window !== "undefined" ? window : this);
