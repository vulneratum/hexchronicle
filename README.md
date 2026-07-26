# HexChronicle

A living sandbox continent for old-school tabletop play, managed as data in this
repo, advanced by an AI agent (Claude Code), and published as an interactive
atlas at **hexchronicle.com**.

The core loop: the GM plays a session at the table → logs it as a file → the
agent updates the world (hexes, settlements, kingdoms, reputations) and advances
everything else by the elapsed in-game time → the site rebuilds and the map,
wiki, and rumors reflect the new state of the world.

**This README is the build brief.** Everything below is a settled design
decision unless marked *(future phase)*.

---

## 1. Game system & tone

- Table rules: **Old-School Essentials (OSE)**.
- World engine: OSE plus **Rules Cyclopedia-derived campaign machinery**
  (domain income, dominion events, War Machine-style mass combat) reformulated
  in our own words — the agent uses these to advance kingdoms. Never reproduce
  Rules Cyclopedia text (see §11 Licensing).
- Onboarding: 0-level funnel play per Carcass Crawler #5-style rules.
- Tone: sword-and-sorcery weird is welcome; **no aliens, no high technology,
  no spaceships.**

## 2. Map structure & addressing

Three nested scales, **12-across** at each step:

| Level | Hex size | Contains |
|---|---|---|
| Continent hex | 432 miles | 12-across field of atlas hexes |
| Atlas hex ("plate") | 36 miles | 12-across field of subhexes |
| Subhex | 3 miles (1 league) | the unit of play |

**Addressing (permanent identifiers, never descriptions of position):**

- Atlas hexes are numbered `0001`, `0002`, … in order of creation.
- Subhexes are numbered row by row within their plate, top-left to
  bottom-right, zero-padded: `0001-001` … `0001-157`.
- **Seam ownership rule:** subhexes that geometrically straddle two atlas
  hexes belong to exactly one parent: the atlas hex whose center is nearest;
  exact ties go to the **lower-numbered** parent. Computed by code, decided
  once, never revised. Renumbering or reassigning any existing address is
  forbidden — the chronicle references addresses forever.
- Neighbor plates still **render** foreign-owned seam hexes, dimmed and
  labeled with their true address.

## 3. Presentation: the atlas plate

The primary view is the **plate**: one atlas hex as the page, point-up, drawn
as its numbered subhexes — styled after classic nested-atlas plates:

- Title cartouche (region name, "36-MILE HEX #NNNN within 432-MILE HEX #N",
  scale line "1 HEX = 3 MILES (1 LEAGUE)").
- Sequential subhex numbers, visible past a zoom threshold.
- Six neighbor chips on the plate edges linking to adjoining plates.
- Continent view zooms out to the field of atlas hexes (semantic zoom:
  different information at different scales, not just smaller hexes).
- **Zoom limits:** maximum zoom is fixed (subhex detail readable); minimum
  zoom is **computed** to fit the entire current map, so it recedes
  automatically as the continent grows. Never hardcode it.
- Renderer: browser-side SVG drawn from compiled world-state JSON. Static
  hosting only — no server. Mobile-first: touch pan/pinch, tap targets via
  select-then-open cards, viewport culling.
- A working prototype of this renderer exists (`hexchronicle-plate-demo.html`
  from the design conversation) — reuse its approach.

## 4. Data architecture

**The repo is the single source of truth.** The site, the editor, the agent,
and any future export (Foundry VTT) all read/write the same files.

### File types

- `hexes/` — one file per subhex that has content: terrain, features,
  line features, names, visibility-flagged sections, chronicle entries,
  local-memory prose.
- `plates/` — one file per atlas hex: number, name, canton/realm, summary.
- `realms/` — kingdoms: ruler, agenda, relations, military posture, domain
  stats, heraldry ref. Cantons/regions as sub-entries or files.
- `people/` — notable NPCs and (later) registered PCs.
- `sessions/` — session logs (see template below).
- `hooks/` — agent-generated rumors per region, refreshed each world turn.
- `world/` — the world clock, active tracks (wars, contests, successions),
  and `world-turn-instructions.md` (the agent's standing rules, versioned
  like everything else).
- `theme/` — `terrain.yaml` (type → color + label) and `icons/` (SVG per
  feature type). See §7 Custom tiles.

### Hard rules

- **Data vs story separation:** machine-updated state and hand-written prose
  live in separate sections/files. A world-turn update must never bulldoze
  authored lore; the editor must never touch chronicle or world state.
- **Visibility:** every content block is `public` or `gm-only`. The site
  build renders public only. Undiscovered dungeons stay undiscovered until a
  session log reveals them.
- **Line features** (streams, canals, rivers, roads by grade, tollpikes,
  bridges, realm/canton borders) are path data crossing hexes — not per-hex
  fills.
- Fetched/derived data is never canon; only logged events and authored
  content are.

### Session log template

Small enough to fill in ten minutes after a session:
date played, **in-game dates / elapsed time**, hexes touched (by address),
events (what actually happened, named consistently), PC/NPC names involved,
treasure/XP notes. Consistent naming is what powers reputation tracking —
maintain a name registry.

## 5. The agent (Claude Code) — world turns

After each session log (and on idle time advancement):

1. **Apply local events** to the touched hexes: chronicle entries, feature
   changes, local-memory rewrites ("the folk of X still talk about…").
   Reputation may grow or distort over time.
2. **Advance the world** by the elapsed in-game time using the standing
   instructions: domain income, dominion events, kingdom agendas, active
   war/contest/succession tracks.
3. **Emit hooks:** 2–3 open-question rumors per active region — some tied to
   continent events, some local. Ignored hooks may escalate on later turns.
4. **Traceability:** every threat or consequence the agent generates must
   trace to logged causes (a chronicle-visible chain), never appear vindictive
   or arbitrary.
5. Commit with a clear message; the site rebuild does the rest.

Ruler deaths trigger the **succession procedure** (heirs, claimants, a
succession track, news hooks to neighbors) — a dead king is an input, never
an endpoint.

## 6. The editor (local web app)

Lives in this repo; shares the renderer and theme modules with the site.

- `npm run editor` → local server → browser UI at localhost. Fully offline;
  the server's only job is reading/writing repo files and running git.
- Features: add a new plate (next number auto-assigned, blank/default fill);
  terrain paint brush; feature stamps; name fields; line tools for
  rivers/roads/borders; automatic seam-ownership computation.
- **Scope guard:** the editor may only modify map-data paths. It must be
  structurally unable to write chronicle, world-state, or session files, and
  its commits may only include allowed paths.
- Commit flow: diff view ("plate 0007: 14 hexes changed"), generated or
  typed commit message, commit + optional push.

## 7. Custom tiles

The editor's palette is built **from the theme registry**, never hardcoded.
Adding a tile = define name + color (+ optional SVG icon) in `theme/`; it
appears in the palette, renders on next build, and flows to every consumer.
Include a "new tile type" form in the editor.

- Type names are **permanent once used** — retire from the palette, never
  rename or delete a definition that any hex references.
- Icons are SVG (theme-able, scale-free). Free sources like game-icons.net
  (CC-BY, credited in the site footer) are acceptable.

## 8. The editor, as built

The design brief is §6; this is how the local editor actually works, so changes
don't break its invariants. `npm run editor` serves the plate view and a narrow,
semantic API from `127.0.0.1` only; every write funnels through the
`editor/guard.js` scope guard (writes limited to `plates/`, `hexes/` map fields,
and `theme/` — never chronicle, world state, or sessions).

- **The plate lattice.** Plates declare neighbours by id, not position, so there
  is no world coordinate system on disk. The server derives one on demand by
  walking the declared-neighbour graph from an origin plate, assigning axial
  coordinates in the **same convention as subhexes** (`shared/geometry.js`): `e`
  is `[1,0]`, `se` is `[0,1]`, and so on — the subhex layout scaled up from
  subhex circumradius `SIZE` to plate circumradius `RL`. This is what lets a new
  plate discover and back-link *every* plate it touches, not just the one it was
  grown from.
- **Active plate at world origin (invariant).** The plate being edited always
  sits at `(0,0)`; the surrounding atlas is drawn relative to it. `hexAt()` maps
  a screen point straight to a subhex in the active plate's map, so painting,
  line drawing, undo, and Save assume the origin and need no offset. **Switching
  plates re-origins the atlas rather than moving the active plate** (slippy-map
  style, no page reload): the new plate is mounted at origin, the incoming
  plate's world position is subtracted from every atlas entry, and the camera is
  compensated (`tx += wx·s`, `ty += wy·s`) so nothing appears to move. Zoom and
  the detail cache survive the switch.
- **Summary / detail atlas split.** `/api/atlas` returns only lightweight
  per-plate summaries (id, name, realm, continent hex, coord, default terrain),
  so its payload stays `O(plates)` rather than `O(plates × 157)` as the map
  grows. A plate's full interior (terrain grid, lines, features) is fetched on
  demand from `/api/plate/:id/detail` and cached client-side (`detailCache`),
  reused across pans and switches.
- **LOD + viewport culling.** Only plates whose bounds intersect the viewport
  (plus a margin) are built; off-screen plates are never fetched or built and are
  torn down when they leave, so node count stays bounded. Above `DETAIL_ZOOM` the
  `MAX_FULL` nearest on-screen plates render as full subhex grids (fetching
  detail if needed); everything else — and everything below `DETAIL_ZOOM` —
  renders as a single flat-coloured hexagon. LOD flips cross-fade rather than
  pop, and plate-id labels are counter-scaled (`1/s`) so they stay a constant
  size at any zoom.
- **SVG click limitation.** `pointerdown` calls `preventDefault()` and sets
  pointer capture, which suppresses the DOM `click` event for everything inside
  the map SVG. So **no element inside the map carries a click listener**; all map
  interaction (paint, line taps, plate switching, opening the add-plate dialog)
  routes through `endPointer()`'s hit test (`atlasAt`), which resolves screen
  coordinates to a plate or an empty slot in world space. Add new map
  interactions there, never via per-element listeners.

## 9. The site (hexchronicle.com)

- Static site on GitHub Pages or Cloudflare Pages, custom domain, HTTPS,
  auto-rebuild on every commit. $0 hosting.
- The map is the front door; every hex links to its generated **wiki page**:
  - *Gazetteer:* terrain, travel info, settlements/features (public only),
    canton/realm links.
  - *Chronicle:* dated event history, local memory, notable deaths, storied
    items, memorials.
  - *Hooks:* current local rumors and active pressures.
  - Meta: address, last-updated world date, neighbor links, and a
    "chronicle a session here" link (pre-filled with the hex address).
- Auto-cross-link consistent names (NPCs, places, items) across pages.
- Every page carries a "suggest an edit" link to its source file on GitHub.
- Images optional garnish: web-compressed, SVG heraldry, icon changes driven
  by state (burned village = burned icon).

## 10. Build order

1. **Walking skeleton:** file formats for one plate + build script rendering
   the plate view + deploy to hexchronicle.com. Prove data → build → live site.
2. **Shared renderer hardened** (plate view, semantic zoom, cards, mobile).
3. **The editor**, on top of the renderer.
4. **Author the starting region** through the editor: one canton, a funnel
   village, a dungeon or two. Continent-level: coastlines and 4–5 named
   realms with one-line agendas, detailed lazily as play approaches.
5. **World-turn instructions** written and tested manually before autopilot.
6. **Play.** First session log through the full loop.

*(Future phases, designed but not built now):* shard/multi-table layer
(protected entities, contest protocol, war tracker with per-week contribution
normalization, "nothing with a name dies off-screen", cross-table hostilities
delivered as threats resolved at the target's table, PC consent flags,
world clock pegged to real time with future-dated event queues); AL-style
organized play (character registry as system of record, posted events with
signups, location/time continuity checks); log submission tiers (GitHub issue
form → pre-filled Google Form + Apps Script → branded form + serverless
function); Foundry VTT export (scene image → journal/pin compendium → live
module reading world-state JSON).

## 11. Licensing

- All world content (continent, realms, NPCs, chronicles) is original IP.
- Pages reproducing OSE **open game content** carry the OGL declaration and
  Section 15 notices; nothing declared Product Identity is used.
- **No Rules Cyclopedia text ever** — RC-derived machinery is reformulated
  or built from OGL-open equivalents.
- The OSE third-party compatibility logo/license is optional, later; never
  imply official Necrotic Gnome status.
- Icon attribution (e.g., game-icons.net CC-BY) in the site footer.

## 12. Conventions for the agent

- Read this README before structural changes; update it when a decision
  changes (the README is itself versioned canon).
- Addresses, type names, and file schemas are append-only in spirit: extend,
  don't break. Anything the chronicle references must remain resolvable
  forever.
- Prefer durable phrasing in chronicle prose; date everything in world time.
- Small, well-messaged commits — the commit log is the world's history of
  histories.
