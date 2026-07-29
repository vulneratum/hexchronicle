/*
 * Hypsometric render of the elevation field, plus a relief inset.
 *
 * Called by tools/phase-a-elevation.js --render=out.png, or standalone:
 *   node tools/render-elevation.js [out.png] [--width=N] [--relief]
 *
 * Like the mask render, every pixel resolves through the REAL subhex lattice,
 * so what you see is what G1 would write.
 */
"use strict";
const fs = require("fs"), path = require("path");
const G = require("../shared/geometry.js");
const frame = require("./worldgen/frame.js");
const { encodePNG } = require("./worldgen/png.js");

/* classic hypsometric ramp: greens low, tan, brown, then rock and snow */
const LAND_STOPS = [
  [0,     [0x7d, 0x94, 0x5c]],
  [600,   [0x94, 0xa5, 0x63]],
  [1500,  [0xc2, 0xbb, 0x76]],
  [3000,  [0xc4, 0x9e, 0x63]],
  [5000,  [0xa8, 0x7c, 0x55]],
  [7500,  [0x8b, 0x6c, 0x5c]],
  [9500,  [0x9c, 0x93, 0x92]],
  [11000, [0xd2, 0xd0, 0xcf]],
  [14000, [0xff, 0xff, 0xff]],
];
const SEA_STOPS = [
  [-16000, [0x11, 0x2b, 0x40]],
  [-9000,  [0x1c, 0x42, 0x5e]],
  [-2500,  [0x2c, 0x5d, 0x7a]],
  [-600,   [0x46, 0x80, 0x9e]],
  [-150,   [0x6b, 0xa4, 0xbc]],
  [0,      [0x8c, 0xc2, 0xd4]],
];
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = (v - a) / (b - a);
      return [Math.round(ca[0] + (cb[0] - ca[0]) * t),
              Math.round(ca[1] + (cb[1] - ca[1]) * t),
              Math.round(ca[2] + (cb[2] - ca[2]) * t)];
    }
  }
  return stops[stops.length - 1][1];
}

const RELIEF_COL = {
  flat:      [0xe8, 0xe2, 0xc8],
  rolling:   [0xbf, 0xc9, 0x8e],
  hills:     [0xa8, 0x8a, 0x63],
  mountains: [0x6f, 0x5b, 0x53],
};

function render(m, out, opts) {
  opts = opts || {};
  const b = frame.bounds();
  const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);
  const W = opts.width || 1500, H = Math.round(W / aspect);
  const rgb = new Uint8Array(W * H * 3);
  const mode = opts.relief ? "relief" : "hypsometric";

  for (let py = 0; py < H; py++) {
    const wy = b.minY + (py + 0.5) / H * (b.maxY - b.minY);
    for (let px = 0; px < W; px++) {
      const wx = b.minX + (px + 0.5) / W * (b.maxX - b.minX);
      const a = G.pxToAxial(wx, wy);
      const cell = m.cells.get(a.q + "," + a.r);
      const i = (py * W + px) * 3;
      if (!cell) { rgb[i] = 0x12; rgb[i + 1] = 0x16; rgb[i + 2] = 0x19; continue; }
      let c;
      if (mode === "relief") {
        c = cell.land ? RELIEF_COL[cell.relief] : [0x2c, 0x4a, 0x5e];
      } else {
        c = cell.land ? ramp(LAND_STOPS, cell.elevation) : ramp(SEA_STOPS, cell.elevation);
      }
      rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
    }
  }

  /*
   * Hillshade computed on the LATTICE, not in screen space. A subhex is only a
   * few pixels across at this width, so a pixel-space gradient is zero inside a
   * cell and a cliff at its boundary — which rendered as corduroy striping
   * rather than terrain.
   */
  if (mode === "hypsometric") {
    const shade = new Map();
    const E1 = [1, 0], E2 = [0, 1];
    for (const c of m.order) {
      if (!c.land) continue;
      const g = (d) => {
        const a1 = m.cells.get((c.q + d[0]) + "," + (c.r + d[1]));
        const b1 = m.cells.get((c.q - d[0]) + "," + (c.r - d[1]));
        return ((a1 ? a1.elevation : c.elevation) - (b1 ? b1.elevation : c.elevation)) / 2;
      };
      const gx = g(E1), gy = g(E2);
      shade.set(c.q + "," + c.r, Math.max(-1, Math.min(1, (-gx - gy) / 320)));
    }
    for (let py = 0; py < H; py++) {
      const wy = b.minY + (py + 0.5) / H * (b.maxY - b.minY);
      for (let px = 0; px < W; px++) {
        const wx = b.minX + (px + 0.5) / W * (b.maxX - b.minX);
        const a = G.pxToAxial(wx, wy);
        const sh = shade.get(a.q + "," + a.r);
        if (sh === undefined) continue;
        const i = (py * W + px) * 3;
        for (let k = 0; k < 3; k++) {
          rgb[i + k] = Math.max(0, Math.min(255, Math.round(rgb[i + k] * (1 + 0.30 * sh))));
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(W, H, rgb));
  console.log(`wrote ${out}  (${W}×${H}, ${mode})`);
}

module.exports = render;

if (require.main === module) {
  const mask = require("./worldgen/mask.js");
  const { buildElevation } = require("./worldgen/elevation.js");
  const { hashSeed } = require("./worldgen/noise.js");
  const argv = process.argv.slice(2);
  const out = argv.find(a => !a.startsWith("--")) || "world/physical/elevation.png";
  const width = Number((argv.find(a => a.startsWith("--width=")) || "").split("=")[1]) || 1500;
  const seed = hashSeed((argv.find(a => a.startsWith("--seed=")) || "").split("=")[1] || "hexchronicle-4712");
  const m = mask.buildMask(seed);
  buildElevation(seed, m);
  render(m, out, { width, relief: argv.includes("--relief") });
}
