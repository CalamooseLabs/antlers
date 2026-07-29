# LanServer — a Deno LAN command server, living in-tree under antlers.
#
# Plain `callPackage`-able builder (not a flake), per flakes/README.md. The Deno
# application source lives in ./app and is compiled with `deno compile`.
# app/src/main.ts has no external imports, so the deno-cache step needs no
# network and builds under the sandbox. Consumed by the root flake as
# `packages.<system>.lanserver`, paired with `nixosModules.lanserver`
# (./module.nix).
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
    or (throw "lanserver: unsupported system ${system}");

  # Pre-resolve the Deno module graph as a fixed-output derivation. main.ts has
  # no external dependencies, but `deno cache` still writes a source-keyed cache,
  # so this hash must be refreshed whenever files under ./app change OR on a deno
  # bump (unlike vibe-server, lanserver's output DID change 2.8.2 → 2.8.3).
  # Keeping the step means added deps continue to build (FODs may fetch).
  denoCache = stdenv.mkDerivation {
    name = "lanserver-deno-cache";
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
    outputHash = "sha256-1nEEnxCCsVqcYEifnMiLScglhV0l5bhtBb29lmZO+4s=";
  };

  # denort runtime that `deno compile` needs for the target triple. Pinned to
  # `deno.version`; the denort release tracks deno, so refresh this hash whenever
  # nixpkgs bumps deno. Last updated for deno 2.8.3 (same v2.8.3 denort-x86_64 zip
  # the other antlers Deno flakes pin).
  denortZip = fetchurl {
    url = "https://dl.deno.land/release/v${deno.version}/denort-${target}.zip";
    hash = "sha256-IU0KQBDJxEMmqC6n/DeFwYmkPNg1Z9kaqk3OOWR1mVQ=";
  };
in
  stdenv.mkDerivation {
    pname = "lanserver";
    version = "1.0.1";
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

    buildPhase = ''
      deno compile \
        --allow-read=/etc/lanserver \
        --allow-run \
        --allow-net \
        --allow-env \
        --cached-only \
        --output ./lanserver \
        --target=${target} \
        src/main.ts
    '';

    installPhase = ''
      mkdir -p $out/bin
      install -m0755 lanserver $out/bin/lanserver
    '';

    meta = {
      description = "LAN command server (executes configured commands via HTTP routes)";
      mainProgram = "lanserver";
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }
