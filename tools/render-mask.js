#!/usr/bin/env node
/*
 * Render the land–sea mask as a single image for approval (WORLDGEN §9).
 *
 *   node tools/render-mask.js [outfile.png] [--width N] [--no-grid]
 *
 * Every pixel is resolved through the REAL subhex lattice — screen point →
 * axial → the cell that owns it — so what you see is exactly what Phase G1
 * would write, not a prettier continuous field sampled behind its back.
 */
"use strict";
const fs = require("fs"), path = require("path");
const G = require("../shared/geometry.js");
const frame = require("./worldgen/frame.js");
const { buildMask } = require("./worldgen/mask.js");
const { hashSeed } = require("./worldgen/noise.js");
const { encodePNG } = require("./worldgen/png.js");

const argv = process.argv.slice(2);
const out = argv.find(a => !a.startsWith("--")) || "world/physical/land-sea-mask.png";
const WIDTH = Number((argv.find(a => a.startsWith("--width=")) || "").split("=")[1]) || 1800;
const GRID = !argv.includes("--no-grid");
const SEED_STR = (argv.find(a => a.startsWith("--seed=")) || "").split("=")[1] || "hexchronicle-4712";

const COL = {
  ocean:  [0x2f, 0x5d, 0x7a],   // world ocean (salt)
  shelf:  [0x4a, 0x82, 0xa0],   // ocean within a plate of land — the shelf
  ridge:  [0x63, 0xa6, 0xb8],   // the drowned ridge: shallow water over the chain
  water:  [0x6f, 0xa8, 0xbe],   // enclosed fresh water
  land:   [0x8d, 0x9b, 0x63],
  high:   [0xb3, 0xa8, 0x84],   // land far from any coast, for depth of field only
  grid:   [0x1b, 0x2a, 0x33],
  edge:   [0xd8, 0xcf, 0xb4],
};

const seed = hashSeed(SEED_STR);
console.log(`seed "${SEED_STR}" → ${seed}`);
const mask = buildMask(seed);
const b = frame.bounds();
const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);
const W = WIDTH, H = Math.round(WIDTH / aspect);
console.log(`rendering ${W}×${H}…`);

/* distance-to-coast in lattice steps, for shelf shading and inland shading.
 * Multi-source BFS from every land/water boundary cell. */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
const dist = new Map();
{
  const q = [];
  for (const c of mask.order) {
    let coastal = false;
    for (const [dq, dr] of DIRS) {
      const n = mask.cells.get((c.q + dq) + "," + (c.r + dr));
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
      const n = mask.cells.get(k);
      if (n && !dist.has(k)) { dist.set(k, d + 1); q.push(n); }
    }
  }
}

const rgb = new Uint8Array(W * H * 3);
const ownerAt = new Int32Array(W * H).fill(-1);

for (let py = 0; py < H; py++) {
  const wy = b.minY + (py + 0.5) / H * (b.maxY - b.minY);
  for (let px = 0; px < W; px++) {
    const wx = b.minX + (px + 0.5) / W * (b.maxX - b.minX);
    const a = G.pxToAxial(wx, wy);
    const cell = mask.cells.get(a.q + "," + a.r);
    const i = (py * W + px) * 3;
    if (!cell) {                                   // outside the frame
      rgb[i] = 0x12; rgb[i + 1] = 0x16; rgb[i + 2] = 0x19;
      continue;
    }
    ownerAt[py * W + px] = parseInt(cell.owner, 10);
    const d = dist.get(a.q + "," + a.r) || 0;
    let c;
    if (cell.type === "land") {
      const t = Math.min(1, d / 26);
      c = [Math.round(COL.land[0] + (COL.high[0] - COL.land[0]) * t),
           Math.round(COL.land[1] + (COL.high[1] - COL.land[1]) * t),
           Math.round(COL.land[2] + (COL.high[2] - COL.land[2]) * t)];
    } else if (cell.type === "water") {
      c = COL.water;
    } else {
      const t = Math.min(1, d / 12);               // coastal shelf → deep
      c = [Math.round(COL.shelf[0] + (COL.ocean[0] - COL.shelf[0]) * t),
           Math.round(COL.shelf[1] + (COL.ocean[1] - COL.shelf[1]) * t),
           Math.round(COL.shelf[2] + (COL.ocean[2] - COL.shelf[2]) * t)];
      // Shallow shelf over the drowned ridge (§VII-B) — blended by the
      // CONTINUOUS field, not by a boolean. Thresholding it drew a hard-edged
      // box across the strait that read as a UI artefact rather than seabed.
      const sf = Math.min(1, (cell.shelfF || 0) / 0.55);
      if (sf > 0) {
        c = [Math.round(c[0] + (COL.ridge[0] - c[0]) * sf),
             Math.round(c[1] + (COL.ridge[1] - c[1]) * sf),
             Math.round(c[2] + (COL.ridge[2] - c[2]) * sf)];
      }
    }
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
  }
}

/* plate boundaries, drawn where the OWNING plate changes between neighbouring
 * pixels — exact by construction, and it shows the 36×36 frame at a glance */
if (GRID) {
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const o = ownerAt[py * W + px];
      if (o < 0) continue;
      const right = px + 1 < W ? ownerAt[py * W + px + 1] : o;
      const down = py + 1 < H ? ownerAt[(py + 1) * W + px] : o;
      if (right !== o || down !== o) {
        const i = (py * W + px) * 3;
        rgb[i] = (rgb[i] * 2 + COL.grid[0]) / 3;
        rgb[i + 1] = (rgb[i + 1] * 2 + COL.grid[1]) / 3;
        rgb[i + 2] = (rgb[i + 2] * 2 + COL.grid[2]) / 3;
      }
    }
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePNG(W, H, rgb));

const s = mask.stats;
const pct = n => (n / s.total * 100).toFixed(2) + "%";
const a = s.archipelago;
console.log(`
land–sea mask
  frame         ${s.total.toLocaleString()} subhexes ≈ ${s.frameSqMi.toLocaleString()} sq mi
  land          ${s.land.toLocaleString()}  ${pct(s.land)}   ≈ ${s.landSqMi.toLocaleString()} sq mi
  ocean (salt)  ${s.ocean.toLocaleString()}  ${pct(s.ocean)}
  water (fresh) ${s.fresh.toLocaleString()}  ${pct(s.fresh)}
  water total   ${(s.waterFraction * 100).toFixed(2)}%   (target ${(mask.params.targetWater * 100).toFixed(0)}%)

${s.continents.map(c => `  ${c.side.padEnd(5)} mass    ${c.sqMi.toLocaleString()} sq mi`).join("\n")}
  archipelago   ${a.count} islands on the drowned ridge, ${a.overThreeHundred} over 300 sq mi
                ${a.sizesSqMi.join(", ")} sq mi
  other islands ${s.otherIslands.length ? s.otherIslands.join(", ") + " sq mi" : "none"}
  shelf         ${s.shelfCells.toLocaleString()} shallow subhexes over the ridge
  fresh bodies  ${s.freshBodies.slice(0, 6).join(", ")}${s.freshBodies.length > 6 ? ` …${s.freshBodies.length} total` : ""}
  threshold     ${mask.thresh.toFixed(6)}
wrote ${out}  (${W}×${H})`);
