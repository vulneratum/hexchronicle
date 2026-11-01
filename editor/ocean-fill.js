/*
 * Compact ocean plates (WORLDGEN §4-B) — pure logic shared by the create,
 * convert, and explode paths in server.js. Kept separate and dependency-free
 * (like plate-gen.js) so it is trivially testable.
 *
 * A compact ocean plate stores `fill: ocean` plus `depth` and an optional
 * `current` at the PLATE level, instead of 157 near-identical subhex records.
 * `default_terrain: ocean` still carries the actual terrain (so the renderer
 * needs no special case — see shared/plate-draw.js), and the `terrain:` grid
 * stays free for a sparse island or wreck without breaking the compact form.
 */
"use strict";

const DEPTHS = ["shelf", "deep"];                          // WORLDGEN §VII-B
const CURRENT_DIRS = ["e", "ne", "nw", "w", "sw", "se"];    // plate-lattice directions
const CURRENT_TEMPS = ["warm", "cold"];

/* `raw` is the client's { direction, temperature } or falsy for "no current".
 * Returns a clean { direction, temperature } or null. Throws on garbage. */
function normalizeCurrent(raw) {
  if (!raw) return null;
  const direction = String(raw.direction || "");
  const temperature = String(raw.temperature || "");
  if (!CURRENT_DIRS.includes(direction)) {
    throw new Error(`unknown current direction "${direction}" (${CURRENT_DIRS.join(", ")})`);
  }
  if (!CURRENT_TEMPS.includes(temperature)) {
    throw new Error(`unknown current temperature "${temperature}" (${CURRENT_TEMPS.join(", ")})`);
  }
  return { direction, temperature };
}

function normalizeDepth(raw) {
  const depth = raw || "shelf";
  if (!DEPTHS.includes(depth)) throw new Error(`unknown depth "${depth}" (${DEPTHS.join(", ")})`);
  return depth;
}

/*
 * Rule 14 (README/WORLDGEN): `ocean` means salt water connected to the world
 * ocean; a fully landlocked body is `water`. Proving actual connectivity would
 * mean flood-filling the whole map, which is out of scope for an editor-side
 * check — this is a LOCAL heuristic only: if every one of the six neighbour
 * directions is already filled by an existing plate, and NONE of them shows
 * water-type terrain along the shared border, the new ocean has nowhere to
 * connect to and is almost certainly landlocked.
 *
 * `adjacency` is { dir: neighbourPlateId } for whichever of the six directions
 * are currently occupied. `edgeSeeds` is the border sample already computed by
 * plate-gen.js's computeEdgeSeeds (or an equivalent) — a list of { sub, type }
 * for this plate's rim, voted from the neighbours actually present.
 *
 * Returns a warning string, or null if there is nothing to warn about (an
 * empty neighbour slot is itself an escape route, so it never warns).
 */
function enclosureWarning(theme, adjacency, edgeSeeds) {
  if (Object.keys(adjacency || {}).length < 6) return null;         // a gap is an escape route
  const waterTypes = new Set(Object.keys((theme && theme.types) || {}).filter(k => theme.types[k].water));
  const touchesWater = (edgeSeeds || []).some(s => waterTypes.has(s.type));
  if (touchesWater) return null;
  return "every neighbouring plate is already filled and none shows water at the shared border — "
    + "this ocean would be landlocked. A fully enclosed salt sea is `water`, not `ocean` (rule 14). "
    + "This only checks immediate neighbours, not the whole map.";
}

module.exports = { DEPTHS, CURRENT_DIRS, CURRENT_TEMPS, normalizeCurrent, normalizeDepth, enclosureWarning };
