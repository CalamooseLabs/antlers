# cobblemon-overlay — the Deno OBS-overlay web service behind
# `services.cobblemon-overlay` (ingests game-state pushes from The Cobblemon
# Initiative's streamsync subsystem and serves transparent overlay pages).
#
# Plain `callPackage`-able builder (not a flake), per flakes/README.md. Mirrors
# the vibe-server build exactly: the Deno application in ./app is compiled with
# `deno compile`. app/src/main.ts has ZERO external imports, so the deno-cache
# step needs no network and builds under the sandbox (its FOD output is empty).
#
# PLUS the box sprites VENDORED in ./sprites (from msikma/pokesprite — no external
# fetch, no hash to maintain): the gen-8 regular icons (INCLUDING regional-form
# slugs like growlithe-hisui.png), the parallel shiny/ icon set, + the dex→slug
# data file are installed to $out/share/cobblemon-overlay/sprites — TRIMMED of the
# large transparent margins the 68×56 canvases carry (imagemagick, at install
# time), so an icon's content box is its actual art and the overlay pages can size
# sprites to their housings. sprites.ts resolves a Pokémon's Cobblemon aspects →
# the regional-form slug and the `shiny` flag → shiny/<slug>. See ./sprites/README.md
# for provenance/credits. Zero internet dependency at build OR stream time. Consumed by the root flake as
# `packages.<system>.cobblemon-overlay`, paired with
# `nixosModules.cobblemon-overlay` (./module.nix).
{
  stdenv,
  deno,
  unzip,
  imagemagick,
  fetchurl,
  glibc,
}: let
  src = ./app;

  inherit (stdenv.hostPlatform) system;
  target =
    {
      "x86_64-linux" = "x86_64-unknown-linux-gnu";
      "aarch64-linux" = "aarch64-unknown-linux-gnu";
    }
    .${
      system
    }
    or (throw "cobblemon-overlay: unsupported system ${system}");

  # Pre-resolve the Deno module graph as a fixed-output derivation. main.ts has
  # no external dependencies, but `deno cache` still writes a cache keyed by the
  # app source, so this hash must be refreshed whenever files under ./app change
  # (and, in principle, on a deno bump). Keeping the step means added deps
  # continue to build (FODs may fetch).
  denoCache = stdenv.mkDerivation {
    name = "cobblemon-overlay-deno-cache";
    inherit src;
    nativeBuildInputs = [deno];
    buildPhase = ''
      export DENO_DIR=./.deno
      mkdir $DENO_DIR
      deno cache --reload src/main.ts
    '';
    installPhase = ''
      mkdir $out
      cp -r .deno/deps $out/ 2>/dev/null || true
      cp -r .deno/npm $out/ 2>/dev/null || true
      cp -r .deno/gen $out/ 2>/dev/null || true
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-PyYGkqm3aaFvWM4WTYqQQl29c25TqbBO9r/MhujIIG8=";
  };

  # denort runtime that `deno compile` needs for the target triple.
  # NOTE: the URL is pinned to `deno.version`, so this hash is deno-version-SPECIFIC and must
  # be refreshed whenever the ambient nixpkgs bumps deno (the denort release tracks the deno
  # version). The version comes from the CONSUMING flake's nixpkgs — when this is built inside
  # cala-m-os (/etc/nixos), antlers' nixpkgs `follows` it, so the real target is that deno
  # (currently 2.8.3 → the hash below). antlers' OWN lock is pinned to the SAME 2.8.3 nixpkgs
  # rev, so standalone `nix build .#cobblemon-overlay` / `nix flake check` resolve deno 2.8.3 too
  # — all four antlers Deno flakes share this v2.8.3 denort hash.
  # Refresh via: nix store prefetch-file "https://dl.deno.land/release/v<ver>/denort-<triple>.zip".
  # Last matched: deno 2.8.3.
  denortZip = fetchurl {
    url = "https://dl.deno.land/release/v${deno.version}/denort-${target}.zip";
    hash = "sha256-IU0KQBDJxEMmqC6n/DeFwYmkPNg1Z9kaqk3OOWR1mVQ=";
  };

  # Sprite source: VENDORED in ./sprites (from msikma/pokesprite) — regular/ box
  # icons keyed by slug incl. regional-form slugs (growlithe-hisui.png, …), the
  # parallel shiny/ set, and pokemon.json (dex→slug map). No fetch, no hash. Sprite
  # images are © Nintendo/Creatures/GAME FREAK (fan-work terms per ./sprites/LICENSE);
  # pokesprite's own code/data are MIT — thanks to msikma. See ./sprites/README.md.
  spriteSrc = ./sprites;
in
  stdenv.mkDerivation {
    pname = "cobblemon-overlay";
    version = "1.0.0";
    inherit src;

    nativeBuildInputs = [deno unzip imagemagick];

    # The compiled Deno binary is a prebuilt ELF; leave it unpatched/unstripped.
    dontAutoPatchELF = true;
    dontStrip = true;

    buildInputs = [stdenv.cc.cc.lib glibc];

    configurePhase = ''
      export DENO_DIR=.deno
      mkdir $DENO_DIR
      ln -s ${denoCache}/deps $DENO_DIR/deps 2>/dev/null || true
      ln -s ${denoCache}/npm $DENO_DIR/npm 2>/dev/null || true
      ln -s ${denoCache}/gen $DENO_DIR/gen 2>/dev/null || true

      mkdir -p ./denort-temp
      (cd ./denort-temp && unzip ${denortZip})
      export DENORT_BIN="$(pwd)/denort-temp/denort"
      chmod +x "$DENORT_BIN"
    '';

    # --allow-write IS scoped to the known state dir; no --allow-run (the
    # service spawns nothing). --allow-read stays broad so spriteDir (runtime
    # config, a store path by default) works; filesystem confinement comes from
    # the systemd sandbox (see module.nix).
    buildPhase = ''
      deno compile \
        --allow-read \
        --allow-write=/var/lib/cobblemon-overlay \
        --allow-net \
        --allow-env \
        --cached-only \
        --output ./cobblemon-overlay \
        --target=${target} \
        src/main.ts
    '';

    installPhase = ''
      mkdir -p $out/bin $out/share/cobblemon-overlay/sprites/shiny
      install -m0755 cobblemon-overlay $out/bin/cobblemon-overlay
      # gen-8 box icons, keyed by slug (regional-form slugs like growlithe-hisui.png
      # are included; ./sprites already excludes the female/ variant subdir), the
      # parallel shiny/ set (sprites.ts reads it for the shiny variants), + the
      # dex→slug map that backs the overlay's dex-number fallback. module.nix
      # defaults spriteDir to this dir.
      cp ${spriteSrc}/regular/*.png $out/share/cobblemon-overlay/sprites/
      cp ${spriteSrc}/shiny/*.png $out/share/cobblemon-overlay/sprites/shiny/
      # Trim the large transparent margins the 68×56 pokesprite canvases carry
      # around the actual art, so an icon's content box IS its art and the
      # overlay pages can size sprite boxes to their housings (the graveyard
      # plaque/plank). Done HERE, on the installed copies — the vendored ./sprites
      # stay byte-identical. -strip + excluding the date/time PNG chunks keeps
      # mogrify's output byte-stable across rebuilds (trim itself is deterministic
      # for identical inputs). The shiny/ set gets the same trim.
      chmod +w $out/share/cobblemon-overlay/sprites/*.png $out/share/cobblemon-overlay/sprites/shiny/*.png
      mogrify -strip -define png:exclude-chunks=date,time -trim +repage \
        $out/share/cobblemon-overlay/sprites/*.png
      mogrify -strip -define png:exclude-chunks=date,time -trim +repage \
        $out/share/cobblemon-overlay/sprites/shiny/*.png
      cp ${spriteSrc}/pokemon.json $out/share/cobblemon-overlay/sprites/pokemon.json
    '';

    meta = {
      description = "OBS stream-overlay web service for The Cobblemon Initiative (behind services.cobblemon-overlay)";
      mainProgram = "cobblemon-overlay";
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }
