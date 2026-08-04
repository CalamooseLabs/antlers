# cobblemon-overlay sprites (vendored)

Pokémon box sprites vendored into the overlay flake so the build has **no
external sprite dependency** — no fetch, no hash to maintain.

- `regular/` — box icons keyed by slug for national dex **gen 1–9**, including
  regional-form slugs (`growlithe-hisui.png`, `meowth-alola.png`, …) and gen-9
  form slugs (`tauros-paldea-combat-breed.png`, `ogerpon-wellspring-mask.png`,
  …). `package.nix` installs these and trims the transparent margins at build
  time.
- `shiny/` — the parallel shiny variants (`sprites.ts` resolves the `shiny` flag
  to this set); regular and shiny are kept as identical slug sets.
- `pokemon.json` — dex-number → slug map (the overlay's dex fallback lookup).
  Upstream pokesprite data, currently max dex 905 (gen 8); gen-9 species still
  resolve via the direct-slug + dash-less loose paths, so no gen-9 entries are
  hand-spliced here (refresh the whole file from upstream if/when pokesprite
  ships gen-9 data — see below).
- `LICENSE` — the upstream pokesprite license / usage terms.

## Source & credits

**Gen 1–8** (national dex 1–905, incl. the Hisui / Legends: Arceus forms) is
taken from **[msikma/pokesprite](https://github.com/msikma/pokesprite)** (the
`pokemon-gen8/{regular,shiny}` sets + `data/pokemon.json`) — thank you.
pokesprite's own code/data are MIT.

**Gen 9** (national dex 906–1025, Scarlet & Violet + The Teal Mask / The Indigo
Disk) is taken from the **[National Pokédex Version Delta Icon Dex
project](https://www.deviantart.com/mbcmechachu/art/National-Pokedex-Icon-Dex-824897934)**
by mbcmechachu and [its
contributors](https://docs.google.com/spreadsheets/d/1kI_PDXnbghxjN2LBvxA6Pz-QqMYlVGN3Z1EivXOYwNY/edit?gid=0#gid=0),
resized to pokesprite's 68×56 canvas so the two sets look cohesive together —
thank you.

Both sets depict characters © Nintendo / Creatures Inc. / GAME FREAK inc. and
are used under the fan-work terms in [`LICENSE`](./LICENSE).

To refresh:

- **gen 1–8** — re-copy `pokemon-gen8/{regular,shiny}/*.png` and
  `data/pokemon.json` from pokesprite over this directory (do NOT hand-splice
  gen-9 dex numbers into `pokemon.json`; pull them in a whole-file upstream
  refresh once pokesprite ships them).
- **gen 9** — re-copy `pokemon/{regular,shiny}/*.png` from the delta-project
  repo, keeping the pokesprite originals where a slug overlaps (the Hisui /
  Legends: Arceus forms) so the whole set stays a single, consistent art style.

Then `git add` the new PNGs (the flake can't see un-added files) and commit.
