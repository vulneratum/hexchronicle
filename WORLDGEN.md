# WORLDGEN.md — Continent Generation Brief

Companion to `README.md`. The README defines the **container** (geometry, addressing,
editor, site). This defines the **content**: how the world is generated, in what order,
and by what rules.

Read `README.md` first. Nothing here overrides it.

---

## 0. Hard constraints

- **Geometry is frozen.** `buildPlateHexes()`, subhex numbering, and seam ownership
  (README §2) are untouchable. Worldgen writes *values into* hexes; it never changes
  which hexes exist or what they're called.
- **Addresses are permanent.** Plate ids are assigned in creation order and never
  reused, renumbered, or deleted.
- **Determinism.** Every generated value derives from a single `world_seed` plus the
  hex address. Re-running generation on an ungenerated plate must produce identical
  output. Record the seed in `world/constants.yaml`.
- **Never overwrite play.** Any hex with a non-empty `chronicle` or `local_memory` is
  canon written by actual sessions. Generation reads those fields and must reconcile
  with them; it never rewrites them.
- **Never overwrite authorship.** See §3 — hand-painted hexes are locked.
- **Licensing.** Rules Cyclopedia–derived machinery is reformulated in our own words.
  Never reproduce its text or tables verbatim.
- **Tone.** Sword-and-sorcery weird. No aliens, no high technology, no spaceships. Table
  rules are Old-School Essentials; pitch encounters, domains, and monsters to OSE.
- **Natural before built.** No work of any hand — human, demihuman, or otherwise —
  is written to the map until the entire natural world is finished (§IX-G1).

---

## 1. World extent — settled

- **Grid: 36 plates wide × 36 plates tall = 1,296 plates.**
- 36 × 36 miles = **1,296 miles** edge to edge, in both directions.
- 1,296 × 157 = **203,472 subhexes** of ground and water.
- Frame area ≈ **1.59 million square miles**; at ~60% land that is **~950,000 square
  miles of continent** — Europe from Ireland to Ukraine, minus Russia and the far north.
- Plate ids run `0001`–`1296`.

**The frame is exactly 3 × 3 continent hexes.** 12 plates = one 432-mile continent hex
(README §2), so a 36-plate frame closes the top tier of the addressing scheme cleanly
instead of leaving a ragged remainder. If this needs to change later, change it in
multiples of 12: 24×24 (576 plates, ~420k sq mi land, Western Europe) or 48×48
(2,304 plates, ~1.7M sq mi, all Europe short of Russia).

**The world is bounded and includes its oceans.** The 36×36 grid is not the continent;
it is the *world frame*. Land occupies the interior, ocean fills the margins, and the
map has true coastline on every side. Nothing exists outside the frame.

---

## 1a. Climate band — settled: Atlantic to Mediterranean

The frame spans roughly **36°N to 56°N** — 20° of latitude, the band that holds England,
Germany, Spain, and Italy. Northern Scotland at the top edge, Sicily and Andalusia at the
bottom. Adjust the endpoints a degree or two if the land–sea mask argues for it; do not
push north into the subarctic or south into the tropics.

**Chosen to keep the GM's job small.** Players already have intuitions for this band —
"this duchy is Bavaria, that coast is Catalonia" — so description costs a sentence
instead of a paragraph. It also spares you the mechanical overhead a frozen world
demands: no freezing rules, no seasonal starvation bookkeeping, no dead months where
nothing can happen. Adventuring runs year-round. That is the right trade for a world
meant to be played at many tables.

### Three climate modes, not one

The band's whole value is that it holds three distinct worlds a day's ride apart:

- **Atlantic west** — mild, wet year-round, cloudy. Westerlies still govern (§VII-D), so
  the west coast is the wet side. Britain, Brittany, Galicia.
- **Mediterranean south** — hot dry summers, wet mild winters, and this is the one that
  changes the rules (see below). Iberia, Italy, the southern coast.
- **Continental east** — colder winters, hotter summers, drier the further from the sea.
  Poland, Hungary, the interior plains.

Which mode a region gets is an output of distance-from-west-coast, latitude, and relief.
Record the mode on every region; the economy and calendar both read from it.

### Seasonality — the two halves close in opposite seasons

This is the most useful mechanic the band gives you, and it is easy to miss.

- **The north and the uplands close in winter.** Alpine and upland passes shut, the odd
  northern river ices, campaigning stops. The sea stays open.
- **The south closes in summer.** Mediterranean summer is a **drought**: rivers run low
  or dry, mills stop, pasture burns off. Southern river navigation is a winter and spring
  affair.

So goods and armies move through the north in summer and through the south in winter, and
the two halves of the map are never fully open at once. Record per region: growing-season
length, months of pass closure, months of low water, and the sailing season on each lane.

**The political consequence is a gift — take it.** In the Mediterranean south, **summer
water is the scarce resource**: whoever holds the springs, cisterns, and irrigation works
holds the harvest, which makes water rights a standing casus belli and a lever the
living-world tick can pull every single year. In the north, land and timber play that
role instead. Same standards doc, different currency.

A second gift: a tideless inland sea in the south makes coastal shipping cheap and safe,
which historically produced **many small maritime powers** — city-states, leagues,
merchant republics. The north, moving goods overland, produces **fewer and larger land
powers**. Let the geography generate that contrast rather than assigning it.

### Palette under this band

All fifteen types have a home, which is why this band suits the brush set better than the
frozen one did. Three rulings and two restrictions:

- **`savanna` = dehesa.** Mediterranean oak savanna is real and it is Spanish: open
  grassland studded with cork and holm oak, grazed rather than ploughed. Keep the name.
- **`jungle` = Atlantic temperate rainforest.** Galicia, Asturias, western Scotland — wet,
  mossy, dense, evergreen. Same brush, same green. Rename to `rainforest` if you want the
  label to stop fighting you, but the type earns its place.
- **`desert` and `badlands` are Iberian, not Saharan.** Tabernas is a true desert at 37°N
  and the Bardenas are true badlands; both sit in rain shadows behind coastal ranges.
  Small, arid, salt-bearing (§VII-H), and out of all proportion in economic importance.
- **`glacier` and `tundra` are alpine only.** No sea-level ice anywhere in the frame.
  They appear above the snowline on the high spine and nowhere else.
- **`taiga` is northern upland only** — the top edge and the higher cold interior. It
  should be the rarest lowland type on the map.

---

## 2. Phase 0 — confirm before generating anything

Ask me these and wait. Do not guess.

1. **Ocean fraction and continental shape** — how much of the 36×36 frame is water, and
   is the land one mass or a mass plus archipelagos? (Suggest: ~35–40% water; one main
   continent, an inland sea, and one island chain offshore.)
2. **Latitude band — settled: Atlantic to Mediterranean.** See §1a. Nothing to ask here; the
   remaining question is only where exactly the southern edge falls, which you may
   propose.
3. **Peoples** — how many non-human races, and are any of them mine already?
4. **Magic's economic weight** — is magic rare enough to ignore in logistics, or does
   it move goods and people? (See §VIII.)
5. **Starting era** — is the world at a high-water mark, a collapse, or a recovery?
6. **Frontier region** — which corner of the map gets full political detail first? (§4)

Then propose a one-paragraph world premise and get my sign-off before Phase A.

---

## 3. Preserving what already exists

Generation must not silently overwrite the map I've already painted.

- Add an **`authored: true`** flag at subhex and plate level. The editor sets it on any
  hex I touch by hand. Generation never writes to a flagged hex; validation rule 10
  fails on any attempt.
- Before Phase G, produce an **audit**: which existing plates are hand-authored, which
  are raw `plate-gen.js` output, and which are empty. I
  decide per-plate what's preserved. Don't decide for me.
- Where existing terrain conflicts with the generated field, report the addresses and
  stop. Do not bend the field to fit, and do not repaint the hex.

---

## 4. Scale, ordering, and materialization

1,296 plates is still a batch job, not 1,296 clicks in the editor. Three things follow.

**A. Creation order is frozen now.** Plates are created **row-major from the top-left of
the frame**: row 0 left-to-right is `0001`–`0036`, row 1 is `0037`–`0072`, and so on.
This makes seam ownership (lower id wins) fully predictable — north and west neighbours
always own their shared seams — and makes the whole world reproducible from the seed.
Write this into README §2 as a permanent rule before generating anything.

**B. Ocean plates get a compact form.** A plate that is entirely open water stores a
single `fill: ocean` plus depth, current, and any islands or wrecks — not 157 near
identical subhex records. Coastal and island plates store in full. Expect this to cut
total repo size by roughly the ocean fraction.

**C. Political detail is frontier-first.** Phases A–C run across the **entire frame** —
they're field computations and they're cheap. Phases D–F do **not**. Generate full
realms, houses, actors, and hooks for one starting region of roughly 60–100 plates — about
one continent hex, or a twelfth of the world — plus
a thin sketch of the powers on its horizon. The rest of the world gets its physical and
economic truth now and its politics when play moves toward it. A fully detailed 1,296-mile
continent is months of tokens and most of it will never see a table.

---

## 5. Order of operations

Causality only runs one direction. Generate in this order, commit after each phase, and
never let a later phase quietly revise an earlier one — if Phase D needs Phase A to be
different, stop and tell me.

| Phase | Produces | Scope | Written to |
|---|---|---|---|
| A | Land–sea mask, ocean, uplift, wind, currents, rain, drainage, coast | Full frame | `world/physical/` |
| **G1** | **Render the natural world: terrain, water, rivers, streams** | **Full frame** | **`plates/`** |
| B | Peoples: biology → values → institutions | Full frame | `world/peoples/` |
| C | Caloric & logistical model: yields, sheds, corridors, sea lanes | Full frame | `world/economy/` |
| D | Political layer: realms, houses, vassals, conflicts | Frontier | `world/realms/` |
| E | Characters: named actors as conflict engines | Frontier | `world/actors/` |
| F | Hooks and rumors, seeded from live WAC cycles | Frontier | `world/hooks/` |
| G2 | Render the works of hands: settlements, roads, borders, ruins | Frontier | `plates/`, `hexes/` |

**The land is finished before anything built on it exists.** G1 comes before B–F on
purpose: settlement placement (§III) is an argument *from* finished geography, so the
geography has to be finished and inspectable first. A–F are reasoning files; G1 and G2
are the only phases that touch `plates/*.yaml` and `hexes/`.

---

## VII. Physical Substrate Standards *(new — extends the standards doc)*

The standards doc assumes a map already exists. It doesn't. Terrain is generated by
**process, not by taste**, so that logistics and politics inherit a world that already
makes sense.

Generate as a **continuous field first, sampled per subhex second.** Store the field in
`world/physical/` at coarse resolution and give `editor/plate-gen.js` a mode that samples
it. This is what makes plate 0047 agree with plate 0012 along their seam without any
special-casing — both read the same field. It is also what makes a 1,296-plate world
tractable: the field is small, the plates are derived.

**A. The land–sea mask, first.** Before any terrain, decide what is land and what is
ocean across the whole frame. This is the single most consequential call in the project
and everything else is downstream of it. Land should reach the frame edge nowhere —
open water rings the world.

**B. Ocean.** Water is not empty space; it is the cheapest transport surface in the
world (§III) and half the climate engine.
- **Shelf vs. deep.** Continental shelf hugs the coast: shallow, fish-rich, and the
  reason a fishing village can exist where no farm can. Deep water beyond.
- **Currents.** Set a gyre. Warm currents make coasts mild and wet; **cold currents make
  coastal deserts** — this is how the Atacama and Namib happen and it is the most useful
  climate tool on the map. Currents also set sailing seasons and one-way trade routes.
- **Sea lanes.** Record the actual navigable routes, their season, and their hazard. These
  are what feed the parasite cities of §IV. A lane without a named harbour at each end is
  not a lane.
- **Islands and archipelagos.** Volcanic arcs, drowned ranges, or coral shelves — each
  chain gets a geological cause.

**C. Uplift.** Place one or two collision spines and a rift or trailing margin. Mountain
ranges are lines, not blobs; foothills grade outward asymmetrically. Elevation is the
root land field — everything below derives from it.

**D. Wind and rain — westerlies.** Prevailing wind runs **west to east** across the whole
frame (§1a), modified by the currents in B. Windward western slopes are wet; leeward is a
**rain shadow**, drying eastward until the next moisture source. A dry region must be
*explainable* by a shadow, a continental interior, or a cold current — never placed
because the map needed variety.

Two things follow. **The Mediterranean south is a summer-dry regime, not a wet one** —
its rain arrives in winter, so a southern river's low season and a northern river's ice
season fall at opposite ends of the year (§1a). And the **eastern interior is the
continental half of the world**: drier, with colder winters and hotter summers the
further it sits from the sea.

**D2. Seasonality is a first-class field.** Record for every region: climate mode,
growing-season length, months of pass closure, months of low water, and the sailing
season on each lane. Everything in §III–IV that assumes year-round transport is wrong
somewhere for part of the year, and the living-world tick needs the calendar to know
when armies can march and when they can only sit.

**E. Drainage.** Water runs downhill and merges; it never splits except at deltas and
never runs uphill. Compute watersheds from the elevation field, then trace trunk rivers
from the wettest highlands to the sea. Lakes only form in closed basins. A river's
**navigable reach** must be recorded explicitly — it is the most important economic fact
on the map (§III water subsidy).

**F. Coast and harbour.** Drowned valleys give ria coasts and natural harbours; uplifted
margins give cliffs and few. Deep-water harbour sites are **scarce and named** — they are
chokepoints as surely as any mountain pass, and on a world this size they decide which
regions can talk to each other at all.

**G. Biome assignment, last — and by matrix.** Terrain type for a subhex is an *output* of
(temperature × moisture × elevation × drainage), resolved in that order. Do not paint
biomes first and rationalize after.

The editor palette is now **15 types**: `water`, `ocean`, `plains`, `savanna`, `scrub`,
`forest`, `taiga`, `jungle`, `swamp`, `hills`, `badlands`, `desert`, `mountains`,
`tundra`, `glacier`. That is dense enough to stop being a judgement call, so make it one:

- **Build a biome assignment matrix** in `world/constants.yaml` — a lookup from
  (temperature band × moisture band) → terrain id, with elevation and drainage as
  overrides. Every terrain written in Phase G must be reproducible from that matrix plus
  the fields. No terrain gets assigned by vibe.
- **Two of these are landform, not biome.** `hills` and `mountains` describe relief;
  the other twelve describe climate. The palette can't express "forested hills," so
  decide the rule once: either relief wins above a stated elevation threshold and the
  climate is recorded in metadata, or it doesn't. Record the choice and apply it
  everywhere. Flag it to me if you think it needs a separate `relief` field instead.
- **`water` vs `ocean` is fresh vs salt**, not big vs small. Inland seas, lakes, and
  rivers are `water`; anything connected to the world ocean is `ocean`. Shelf depth and
  current belong in metadata, not in a second blue.
- **`glacier` is both climate and engine.** Glaciers feed rivers, carve the valleys
  below them, and imply a snowline that varies with latitude. Place them from the
  temperature field and elevation together, and connect their meltwater to the drainage
  graph in §VII-E.
- **`badlands` is your evaporite terrain.** Where §IV wants a salt source in a dry
  basin, badlands is where it goes — which makes those hexes economically important out
  of all proportion to how barren they look.
- Every one of the 15 must appear somewhere in the world, or you must tell me which are
  absent and why the climate model excludes them.

**H. Resources are geological, not decorative.** Metals go in orogenic belts and their
erosional aprons. Salt goes in evaporite basins, brine springs, and sea pans — and where
none exist, that region is flagged **salt-starved** (§IV). Coal goes in ancient swamp
basins. Fuelwood is a function of biome and of how long people have been cutting. Every
deposit gets a one-line geological justification in its record.

**Checkable outputs of Phase A:** land–sea mask, bathymetry and current map, elevation
field, moisture field, river graph with navigability flags, harbour list, sea-lane list,
resource register.

---

## VIII. Hazard & Magic Standards *(new)*

Two forces in this genre can void the logistics engine. Model them explicitly or they
will quietly break every conclusion in §III–V.

**A. The wilderness tax.** OSE wilderness is dangerous, and danger is a *cost per mile*.
Assign each subhex a hazard grade — **including water hexes**, where storm season, reefs,
and whatever lives down there make a short lane worse than a long one. A route's effective
distance is real distance × hazard. This is why the 3-day bulk radius contracts in bad
country, why fertile land stays empty, and why patrol costs are a line item in every
barony's budget. Monsters are not encounters — they are **tariffs**.

**B. Magic must pay its way.** If magic moves goods, people, or water, then every place it
does so becomes a chokepoint with an owner, a price, and a rival who wants it. A teleport
circle is a trade corridor. A weather-working priesthood is an agricultural subsidy and
therefore a political faction. On a 1,296-mile map, anything that beats sail speed is a
strategic asset and must be owned by someone. If magic does *none* of this, state so once
and let the material rules govern. What is forbidden is magic that solves a logistical
problem without anyone having gained power from solving it.

---

## IX. Rendering Standards — reasoning into hex data *(new)*

Rendering is a translation pass, not a creative one. Every value written must trace to a
reasoning file. It happens in two passes that are never mixed.

### G1 — the natural world, complete and alone

**Nothing made by hands, of any kind, is written in G1.** Not a hamlet, not a cart track,
not a border, not a ruin, not a worked mine, not a place name. The map at the end of G1
is the world as it was before anyone walked on it.

- **Terrain** ← sampled continental field (§VII-G), all 1,296 plates.
- **Water** ← the land–sea mask. Ocean plates use the compact form (§4-B). The existing
  shoreline smoothing and sector-blend rules apply unchanged at coast.
- **Rivers and streams** ← the river graph (§VII-E). These are the **only** line features
  G1 may write. Classify by Strahler order from the drainage computation: order 1–2 is
  `stream`, order 3+ is `river`, and every reach carries its navigability and low-water
  season (§1a). Waterways merge at junctions per the editor's existing rule.
- **Natural features** ← caves, springs, hot springs, natural fords, passes, natural
  harbours, waterfalls, deposits *in the ground*. These are landscape, not works, and
  they belong in G1 — they are also precisely the chokepoints and resources that G2 will
  argue from.
- **`chronicle` / `local_memory`** ← left alone.

**Rulings on the edge cases**, so there's no room to improvise:

| In G1 | Held for G2 |
|---|---|
| Cave, spring, ford, pass, natural harbour | Bridge, tunnel, causeway, quarried ford |
| Ore body, salt basin, coal seam in the ground | Mine, saltern, pit, spoil heap |
| Old-growth forest, marsh, heath | Coppice, field, terrace, drained fen, pasture |
| Rock shelter, sea stack, sinkhole | Ruin, barrow, dungeon, standing stone, road |

**No proper names in G1.** Rivers and mountains are named by whoever reached them first,
and nobody has yet. Naming happens after Phase B, and *which* people named a feature is
itself a fact worth having. Refer to features by address until then.

**Creature lairs are not G1 either.** They're a living layer, not a landform; hold them
until after B so that what lives where can answer to the ecology and the peoples both.

G1 ends with a full-frame render for my inspection and a `git tag`. Do not begin B until
I have looked at it.

### G2 — the works of hands, after B–F

- **Roads/paths** ← the corridor model, following least hazard-weighted cost between
  political centers, never straight lines. Road categories are written here and only here.
- **Settlements** ← placement nodes only: chokepoints, surplus zones, junctions,
  logistical shadows (§III), plus **harbours and shelf fisheries** on the coast. A
  settlement placed anywhere else must justify itself in one sentence or be moved.
- **Population** ← computed, never chosen. Count arable subhexes inside the shed, apply
  the yield ratio, latitude growing-season modifier, and farmer fraction from
  `world/constants.yaml`, subtract the wilderness tax, and let the number fall where it
  falls. If a city exceeds its ceiling, it is a **parasite city** and its import lane must
  exist on the map.
- **Borders, ruins, worked sites, and names** ← from D–F.
- **Feature icons and metadata** ← per README §2 conventions, via existing editor shapes.
  Names live in the data; no plate-level text is ever written to the map surface.

Write plates in ascending id order (§4-A) in both passes so seam ownership resolves
deterministically.

---

## 6. Constants

Create `world/constants.yaml` and have both the generator and the living-world tick read
from it, so the world and its future never drift apart. Seed it with: grid 36×36; subhex
3 mi / plate 36 mi / continent hex 432 mi; ox consumption 10% of cargo per 50 miles; bulk
trade radius 60 miles (= 20 subhexes); water transport efficiency multiplier; farmer
fraction 0.80–0.95; temperate lowland yield 4:1; sailing speeds by season; and the
growing-season length, yield modifier, and closure months per latitude band (§1a).

**Then build a per-terrain table with a row for every one of the 15 types**, holding at
minimum: arable fraction, yield ratio, fuelwood availability, movement cost, and hazard
multiplier. The caloric ceiling in §IX and the wilderness tax in §VIII-A both read from
it, so a missing row is a silent wrong answer rather than an error. Alongside it, the
biome assignment matrix from §VII-G.

These are game constants, not history — but they must be *one* set of constants, used
everywhere.

---

## 7. Applying the standards doc

- **WAC (§I)** is the file format for everything in Phases D–F, not a one-time exercise.
  Every realm, house, and named actor carries at least one **open** cycle — a Want with an
  unresolved Action. The living-world tick advances open cycles; hooks are generated from
  them. A world with no open cycles is a dead world and fails validation.
- **Biology (§II)** runs before culture. Each people gets its gives / costs / experiences
  triple, and every cultural trait must trace back to one of the three. Record at least one
  **misattribution of intent** per pair of neighbouring peoples — those are the cheapest,
  best adventure hooks on the map.
- **Fractal politics (§V)** means three nested layers of conflict per region: great house,
  vassal house, individual lord. Each vassal bond names which of the seven loyalty tools
  holds it and therefore which vulnerability breaks it. The tick uses those as levers.
- **Characters (§VI)** get all four fields — institutional goal, personal ambition,
  cognitive architecture, hidden contradiction — or they don't get written.

---

## 8. Validation

Build `tools/validate-world.js` and run it at the end of every phase. It should fail on:

1. A river flowing uphill, splitting outside a delta, or a lake in an open basin.
2. A desert with no rain shadow, interior, or cold current explaining it.
3. A settlement above its computed caloric ceiling with no import lane on the map.
4. A bulk-grain dependency past 20 subhexes with no navigable water.
5. A salt-starved region containing a salt source, or vice versa.
6. A realm or house with zero open WAC cycles.
7. A named actor missing any of the four §VI fields.
8. Any write outside `plates/`, `hexes/`, `theme/`, `world/`, or to a populated
   `chronicle` / `local_memory`.
9. A seam subhex whose values differ between its two parent plates.
10. Any write to a hex flagged `authored: true`.
11. Land touching the frame edge, or a sea lane with no named harbour at both ends.
12. A terrain assignment the biome matrix doesn't reproduce from that hex's fields.
13. A terrain id missing a row in the per-terrain constants table.
14. `ocean` on a hex with no path to the world ocean, or `water` on one that has one.
15. `glacier` below the snowline for its latitude, or a glacier whose meltwater doesn't
    enter the river graph.
16. `glacier` or `tundra` below the alpine snowline, or `taiga` outside the northern
    upland zone (§1a).
17. A caloric ceiling computed without the growing-season modifier for its latitude.
18. A trade route, sea lane, or campaign assumption that ignores its closure months.
19. A region with no climate mode recorded, or a Mediterranean region whose calendar
    treats summer as its wet season.
20. **In G1:** any settlement, road or path line, border, ruin, worked site, proper name,
    or creature lair anywhere in `plates/`.
21. A waterway whose `stream`/`river` class disagrees with its Strahler order, or a reach
    with no navigability and low-water season recorded.

Failures print the address and the rule number. Do not auto-fix — report and stop.

---

## 9. Working protocol

- One phase per branch, merged to `main`, `docs/` rebuilt before push. Nothing reaches
  hexchronicle.com from a side branch.
- After each phase, give me a **one-page summary** of what was decided and what it
  forecloses, before starting the next.
- Phase A ends with the land–sea mask rendered as a single image for my approval before
  anything else is computed on top of it.
- When a rule here and a rule in `README.md` conflict, stop and ask. Don't reconcile them
  yourself.
