# moosebroom — a TUI that finds and reclaims wasted disk space (Rust/ratatui).
#
# The repo's second Rust crate, built exactly like moosewire:
# `rustPlatform.buildRustPackage` with an in-tree Cargo.lock (cargoLock.lockFile
# vendors crates from the lockfile's checksums — no cargoHash to churn). The
# dependency set is identical to moosewire (ratatui + its transitive deps only),
# so the two share a lockfile shape.
#
# moosebroom reclaims space by shelling out to the system's own tools:
#   nix-collect-garbage / nix-store   (Nix generations, GC, store optimise)
#   journalctl                        (systemd journal vacuum)
# and, when present on PATH at runtime, docker / podman. We wrap the binary with
# a PATH *suffix* so the host's own nix/systemd win (matching the running nix
# daemon), only falling back to these if a host somehow lacks them. Container
# runtimes are intentionally NOT baked — they are detected at runtime and are a
# system-level concern, not this tool's to pin.
{
  lib,
  rustPlatform,
  makeWrapper,
  nix,
  systemd,
}:
rustPlatform.buildRustPackage {
  pname = "moosebroom";
  version = "0.1.0";

  src = lib.cleanSource ./.;

  cargoLock.lockFile = ./Cargo.lock;

  nativeBuildInputs = [makeWrapper];

  postInstall = ''
    wrapProgram $out/bin/moosebroom \
      --suffix PATH : ${lib.makeBinPath [nix systemd]}
  '';

  meta = {
    description = "TUI that finds and reclaims wasted disk space: Nix generations, caches, dev/container junk, and an ncdu-style scan";
    mainProgram = "moosebroom";
    platforms = lib.platforms.linux;
    license = lib.licenses.mit;
  };
}
