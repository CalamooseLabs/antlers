# vibe-server — the Deno web service behind `services.vibe-server`.
#
# Plain `callPackage`-able builder (not a flake), per flakes/README.md. Mirrors
# the lanserver build exactly: the Deno application in ./app is compiled with
# `deno compile`. app/src/main.ts has ZERO external imports, so the deno-cache
# step needs no network and builds under the sandbox (its FOD output is empty).
# Consumed by the root flake as `packages.<system>.vibe-server`, paired with
# `nixosModules.vibe` (../vibe/module.nix).
{
  stdenv,
  deno,
  unzip,
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
    or (throw "vibe-server: unsupported system ${system}");

  # Pre-resolve the Deno module graph as a fixed-output derivation. main.ts has
  # no external dependencies, so the output is empty and the hash is stable;
  # keeping the step means added deps continue to build (FODs may fetch).
  denoCache = stdenv.mkDerivation {
    name = "vibe-server-deno-cache";
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
    outputHash = "sha256-5+NJ6TZ6x9cXqv6VMMlgxem8eIU+r+2B5sjOrGJ/jcQ=";
  };

  # denort runtime that `deno compile` needs for the target triple.
  denortZip = fetchurl {
    url = "https://dl.deno.land/release/v${deno.version}/denort-${target}.zip";
    hash = "sha256-qCuGkPfCb23wgFoRReAhCPQ3o6GtagWnIyuuAdqw7Ns=";
  };
in
  stdenv.mkDerivation {
    pname = "vibe-server";
    version = "1.0.0";
    inherit src;

    nativeBuildInputs = [deno unzip];

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

    # Broad --allow-read/-run/-net/-env: the project dirs and the spawn target
    # are runtime config, so they cannot be path-scoped at compile time —
    # filesystem confinement comes from the systemd sandbox (see module.nix),
    # not these flags. --allow-write IS scoped to the known state dirs.
    buildPhase = ''
      deno compile \
        --allow-read \
        --allow-write=/var/lib/vibe,/run/vibe \
        --allow-run \
        --allow-net \
        --allow-env \
        --cached-only \
        --output ./vibe-server \
        --target=${target} \
        src/main.ts
    '';

    installPhase = ''
      mkdir -p $out/bin
      install -m0755 vibe-server $out/bin/vibe-server
    '';

    meta = {
      description = "vibe web service — browser session manager for Claude Code (behind services.vibe-server)";
      mainProgram = "vibe-server";
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }
