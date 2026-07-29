# cobblemon-overlay sprites (vendored)

Pokémon box sprites vendored into the overlay flake so the build has **no
external sprite dependency** — no fetch, no hash to maintain.

- `regular/` — gen-8 box icons keyed by slug, including regional-form slugs
  (`growlithe-hisui.png`, `meowth-alola.png`, …). `package.nix` installs these
  and trims the transparent margins at build time.
- `shiny/` — the parallel shiny variants (`sprites.ts` resolves the `shiny` flag
  to this set).
- `pokemon.json` — dex-number → slug map (the overlay's dex fallback lookup).
- `LICENSE` — the upstream pokesprite license / usage terms.

## Source & credits

Taken from **[msikma/pokesprite](https://github.com/msikma/pokesprite)** (the
gen-8 `pokemon-gen8/{regular,shiny}` sets + `data/pokemon.json`) — thank you.
pokesprite's own code/data are MIT; the sprite images depict characters
© Nintendo / Creatures Inc. / GAME FREAK inc. and are used under the fan-work
terms in [`LICENSE`](./LICENSE).

To refresh (e.g. a new generation or added forms): re-copy
`pokemon-gen8/{regular,shiny}/*.png` and `data/pokemon.json` from upstream over
this directory and commit.
