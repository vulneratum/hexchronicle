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

  const HexGeo = {
    SQ3, SIZE, RL,
    axialToPx, pxToAxial, hexCorners, plateCorners, insidePlate,
    buildPlateHexes, neighborDirs,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = HexGeo;
  else global.HexGeo = HexGeo;
})(typeof window !== "undefined" ? window : this);
