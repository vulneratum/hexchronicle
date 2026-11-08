# Features on water hexes

Every subhex is now drawn as a plain hexagon in its own terrain colour, so a
feature on a hex painted a water type (`water: true` in `theme/terrain.yaml`:
`water`, `ocean`) draws as its icon on solid water. These are the hexes to
repaint in the editor.

Generated 2026-11-08 from every `hexes/*.yaml` with a `feature`, with terrain
read from the owning plate in `plates/`. 5 hexes carry a feature; 4 of them are
on water.

| Address  | Feature  | Name       | Terrain |
|----------|----------|------------|---------|
| 2863-139 | town     | Kingsreach | ocean   |
| 2863-140 | dungeon  | (unnamed)  | ocean   |
| 2863-147 | ruin     | (unnamed)  | ocean   |
| 2863-149 | landmark | Lighthouse | ocean   |

Not on water, for completeness: 2863-126 Hillnest (village) is plains.
