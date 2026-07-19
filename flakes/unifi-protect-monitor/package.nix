# unifi-protect-monitor — the Deno web service behind `services.unifi-protect-monitor`.
#
# Plain `callPackage`-able builder (consumed by the root flake as
# `packages.<system>.unifi-protect-monitor`), modeled on antlers' vibe-server /
# robomoose: the Deno app in ./app/server is compiled with `deno compile`. main.ts has
# ZERO external imports, so the graph is purely local — the build runs offline in the
# ordinary sandbox with --no-remote (no dep-vendoring FOD); the only network dependency
# is the denort runtime below, a proper fetchurl FOD pinned to the deno version.
#
# `--unsafely-ignore-certificate-errors` is baked in: the backend talks to a local,
# self-signed UniFi console over the LAN where the X-API-KEY is the auth boundary and
# TLS pinning of a rotating self-signed cert adds friction without real benefit. It also
# lets the hand-rolled WS client (server/ws.ts) reach the console over wss. The compiled
# binary makes no other outbound TLS calls. See README / module.nix.
{
  lib,
  stdenv,
  deno,
  unzip,
  glibc,
  fetchurl,
}: let
  # Only what the server binary needs: server/*.ts + deno.jsonc. viewer/ and test/ are
  # built/run elsewhere and excluded from the compiled artifact.
  appSrc = lib.fileset.toSource {
    root = ./app;
    fileset = lib.fileset.unions [./app/server ./app/deno.jsonc];
  };

  inherit (stdenv.hostPlatform) system;
  target =
    {
      "x86_64-linux" = "x86_64-unknown-linux-gnu";
      "aarch64-linux" = "aarch64-unknown-linux-gnu";
    }
    .${
      system
    }
    or (throw "unifi-protect-monitor: unsupported system ${system}");

  # denort runtime that `deno compile` needs for the target triple. Pinned to
  # `deno.version`; the denort release tracks deno, so refresh this hash whenever nixpkgs
  # bumps deno. Last updated for deno 2.8.3 (same hash as vibe-server / robomoose).
  denortZip = fetchurl {
    url = "https://dl.deno.land/release/v${deno.version}/denort-${target}.zip";
    hash = "sha256-qpgM4qrhv9dx6og0e8oW4qEqiWdsO+DAR4yzvE1tYkE=";
  };
in
  stdenv.mkDerivation {
    pname = "unifi-protect-monitor";
    version = "1.0.0";
    src = appSrc;

    nativeBuildInputs = [deno unzip];

    # The compiled Deno binary is a prebuilt ELF; leave it unpatched/unstripped (run
    # under nix-ld via the module).
    dontAutoPatchELF = true;
    dontStrip = true;

    buildInputs = [stdenv.cc.cc.lib glibc];

    configurePhase = ''
      mkdir -p ./denort-temp
      (cd ./denort-temp && unzip ${denortZip})
      export DENORT_BIN="$(pwd)/denort-temp/denort"
      chmod +x "$DENORT_BIN"
    '';

    # Broad --allow-*: the console URL, the ffmpeg spawn, and the state dir are runtime
    # config, so none can be path-scoped at compile time — filesystem confinement is the
    # systemd sandbox (module.nix), the real boundary.
    buildPhase = ''
      export DENO_DIR="$TMPDIR/deno"
      mkdir -p "$DENO_DIR"
      deno compile \
        --allow-read \
        --allow-write \
        --allow-run \
        --allow-net \
        --allow-env \
        --unsafely-ignore-certificate-errors \
        --no-remote \
        --output ./unifi-protect-monitor \
        --target=${target} \
        server/main.ts
    '';

    installPhase = ''
      mkdir -p $out/bin
      install -m0755 unifi-protect-monitor $out/bin/unifi-protect-monitor
    '';

    meta = {
      description = "UniFi Protect camera-wall web service (behind services.unifi-protect-monitor)";
      mainProgram = "unifi-protect-monitor";
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }
