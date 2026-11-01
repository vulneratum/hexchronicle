// World -> HexChronicle plates, in compact typed arrays. Uses HexGeo
// (shared/geometry.js) so lattice, numbering and seam ownership match the site.
function worldToPlates(w, G, opt) {
  opt = opt || {};
  const BIO = ['ocean','water','plains','savanna','scrub','forest','taiga','jungle','swamp','hills','badlands','desert','mountains','tundra','glacier'];
  const SQ3 = Math.sqrt(3), MPX = 3 / (SQ3 * G.SIZE);           // miles per world px
  const W = w.W, H = w.H;
  const cx0 = w.origin ? w.origin[0] : W * 1.5, cy0 = w.origin ? w.origin[1] : H * 1.5;
  const geo = G.buildPlateHexes(), NS = geo.length;
  const cellOf = (mx, my) => { const gx = Math.floor(mx / 3), gy = Math.floor(my / 3); return (gx < 0 || gy < 0 || gx >= W || gy >= H) ? -1 : gy * W + gx; };
  const bil = (arr, mx, my) => {
    const u = mx / 3 - 0.5, v = my / 3 - 0.5, x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const cl = (a, m) => a < 0 ? 0 : a >= m ? m - 1 : a;
    const xa = cl(x0, W), xb = cl(x0 + 1, W), ya = cl(y0, H), yb = cl(y0 + 1, H);
    return (arr[ya * W + xa] * (1 - fx) + arr[ya * W + xb] * fx) * (1 - fy) + (arr[yb * W + xa] * (1 - fx) + arr[yb * W + xb] * fx) * fy;
  };
  const tOf = c => c < 0 ? 0 : w.ocean[c] ? 0 : w.lake[c] ? 1 : w.biome[c];

  // 1. plate positions covering the map; keep land plates + one ring of ocean
  const RLm = G.RL * MPX, cand = [];
  const qSpan = Math.ceil(W * 3 / (SQ3 * RLm)) + 4, rSpan = Math.ceil(H * 3 / (1.5 * RLm)) + 3;
  for (let pr = -rSpan; pr <= rSpan; pr++) for (let pq = -qSpan - rSpan; pq <= qSpan + rSpan; pq++) {
    const o = G.plateToPx(pq, pr), mx = cx0 + o.x * MPX, my = cy0 + o.y * MPX;
    if (mx < -RLm || my < -RLm || mx > W * 3 + RLm || my > H * 3 + RLm) continue;
    let land = 0;
    for (let k = 0; k < NS; k++) if (tOf(cellOf(mx + geo[k].x * MPX, my + geo[k].y * MPX)) !== 0) { land = 1; break; }
    cand.push({ q: pq, r: pr, mx, my, land });
  }
  const key = (q, r) => q + ',' + r, byPos = new Map(cand.map(c => [key(c.q, c.r), c])), keep = new Set();
  for (const c of cand) if (c.land) { keep.add(key(c.q, c.r)); for (const d of Object.values(G.PLATE_DIR)) { const k2 = key(c.q + d[0], c.r + d[1]); if (byPos.has(k2)) keep.add(k2); } }
  // fill enclosed sea: any candidate that cannot reach the outside without crossing a kept plate
  { const out = new Set(), st = [];
    for (const c of cand) { const k = key(c.q, c.r); if (keep.has(k)) continue;
      let border = false; for (const d of Object.values(G.PLATE_DIR)) if (!byPos.has(key(c.q + d[0], c.r + d[1]))) border = true;
      if (border) { out.add(k); st.push(c); } }
    while (st.length) { const c = st.pop(); for (const d of Object.values(G.PLATE_DIR)) { const k2 = key(c.q + d[0], c.r + d[1]); const n = byPos.get(k2); if (!n || keep.has(k2) || out.has(k2)) continue; out.add(k2); st.push(n); } }
    for (const c of cand) { const k = key(c.q, c.r); if (!keep.has(k) && !out.has(k)) keep.add(k); } }
  const list = cand.filter(c => keep.has(key(c.q, c.r)));
  list.sort((a, b) => a.r - b.r || (a.q + a.r / 2) - (b.q + b.r / 2));      // row by row, top-left first
  const NP = list.length;
  list.forEach((c, i) => { c.id = String(i + 1).padStart(4, '0'); c.idx = i; });
  const coords = {}; for (const c of list) coords[c.id] = [c.q, c.r];
  const own = G.plateOwnership(coords);
  const pIndex = new Map(list.map(c => [c.id, c.idx]));
  const subIndex = new Map(geo.map((h, k) => [h.sub, k]));

  // 2. one record per physical subhex; slot = plateIdx*NS + geoIdx of its OWNER
  const hexIdx = new Map(), slots = [], mxs = [], mys = [];
  const slotOf = new Int32Array(NP * NS);          // every plate position -> physical hex index
  for (const c of list) for (let k = 0; k < NS; k++) {
    const h = geo[k], wk = (h.q + 12 * c.q) * 100000 + (h.r + 12 * c.r);
    let j = hexIdx.get(wk);
    if (j === undefined) {
      const o = own.ownerOf(c.id, h.sub);
      j = slots.length; hexIdx.set(wk, j);
      slots.push(pIndex.get(o.plateId) * NS + subIndex.get(o.sub));
      mxs.push(c.mx + h.x * MPX); mys.push(c.my + h.y * MPX);
    }
    slotOf[c.idx * NS + k] = j;
  }
  const M = slots.length;
  const contA = new Uint8Array(M), terr = new Uint8Array(M), elev = new Float32Array(M), rain = new Float32Array(M), temp = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const ci = cellOf(mxs[i], mys[i]); terr[i] = tOf(ci); if (w.cont && ci >= 0) contA[i] = w.cont[ci];
    elev[i] = bil(w.ft, mxs[i], mys[i]); rain[i] = bil(w.rain, mxs[i], mys[i]); temp[i] = bil(w.temp, mxs[i], mys[i]);
    if (terr[i] > 1 && elev[i] < 5) elev[i] = 5;
  }
  // neighbours on the world hex lattice
  const nb = new Int32Array(M * 6).fill(-1), D6 = G.neighborDirs;
  for (const c of list) for (let k = 0; k < NS; k++) {
    const i = slotOf[c.idx * NS + k], h = geo[k];
    for (let d = 0; d < 6; d++) { const j = hexIdx.get((h.q + 12 * c.q + D6[d][0]) * 100000 + (h.r + 12 * c.r + D6[d][1])); if (j !== undefined) nb[i * 6 + d] = j; }
  }

  // 3. drainage on the hex lattice: priority flood from the sea, then accumulate
  const fe = Float32Array.from(elev), rec = new Int32Array(M).fill(-1), done = new Uint8Array(M), order = new Int32Array(M); let on = 0;
  const hk = new Float32Array(M + 8), hv = new Int32Array(M + 8); let hn = 0;
  const push = (k, v) => { let i = hn++; while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
  const pop = () => { const top = hv[0], n = --hn; if (n > 0) { const k = hk[n], v = hv[n]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = k; hv[i] = v; } return top; };
  for (let i = 0; i < M; i++) {
    let edge = false; for (let d = 0; d < 6; d++) if (nb[i * 6 + d] < 0) edge = true;
    if (terr[i] === 0 || edge) { done[i] = 1; push(terr[i] === 0 ? -1e6 : fe[i], i); }
  }
  while (hn) {
    const c = pop(); order[on++] = c;
    for (let d = 0; d < 6; d++) { const j = nb[c * 6 + d]; if (j < 0 || done[j]) continue; done[j] = 1; if (fe[j] <= fe[c]) fe[j] = fe[c] + 0.01; rec[j] = c; push(fe[j], j); }
  }
  const HEXAREA = 7.79, flow = new Float32Array(M);
  for (let i = 0; i < M; i++) flow[i] = terr[i] === 0 ? 0 : Math.max(0, rain[i]) / 30;
  for (let o = on - 1; o >= 0; o--) { const i = order[o], r = rec[i]; if (r >= 0) flow[r] += flow[i]; }

  // 4. outputs: per plate position terrain + survey (seams carry the owner's values)
  const C = new Uint8Array(NP * NS), T = new Uint8Array(NP * NS), S = new Int32Array(NP * NS * 4);
  for (let p = 0; p < NP * NS; p++) {
    const i = slotOf[p]; T[p] = terr[i]; C[p] = contA[i];
    S[p * 4] = Math.round(elev[i]); S[p * 4 + 1] = Math.round(rain[i]); S[p * 4 + 2] = Math.round(temp[i]); S[p * 4 + 3] = Math.round(flow[i] * HEXAREA);
  }
  // river/stream edges, owner slot -> owner slot, with basin size
  const minBasin = opt.minBasin || 500, th = minBasin / HEXAREA, edges = [];
  for (let i = 0; i < M; i++) { if (terr[i] <= 1 || flow[i] < th || rec[i] < 0) continue; edges.push(slots[i], slots[rec[i]], Math.round(flow[i] * HEXAREA)); }
  const plates = list.map(c => ({ id: c.id, coord: [c.q, c.r], land: c.land }));
  let landHex = 0; for (let i = 0; i < M; i++) if (terr[i] !== 0) landHex++;
  return { plates, T, S, C, E: Int32Array.from(edges), NS, BIO,
    stats: { plates: NP, landPlates: list.filter(c => c.land).length, subhexes: M, landHex } };
}
if (typeof module !== 'undefined') module.exports = { worldToPlates };
