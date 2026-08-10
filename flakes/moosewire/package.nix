# moosewire — dual-pane SSH/SCP file-mover TUI (Rust/ratatui).
#
# A plain `callPackage`-able builder, per flakes/README.md. Unlike the Deno
# packages here (lanserver/vibe-server/…), this is the repo's first Rust crate:
# `rustPlatform.buildRustPackage` with an in-tree Cargo.lock (cargoLock.lockFile
# vendors crates from the lockfile's checksums — no cargoHash to churn, and no
# new flake input since nixpkgs already ships rustPlatform).
#
# moosewire drives the remote side by shelling out to the system `ssh`/`scp`, so
# there are NO native build inputs (it never links libssh/openssl); we only wrap
# the binary so `openssh` is guaranteed on PATH at runtime. Consumed by the root
# flake as `packages.<system>.moosewire` + `overlays.default.moosewire`.
{
  lib,
  rustPlatform,
  makeWrapper,
  openssh,
}:
rustPlatform.buildRustPackage {
  pname = "moosewire";
  version = "0.1.0";

  src = lib.cleanSource ./.;

  cargoLock.lockFile = ./Cargo.lock;

  nativeBuildInputs = [makeWrapper];

  # The TUI calls `ssh`/`scp` directly; make sure they resolve even on a host
  # that doesn't have openssh in the user's PATH.
  postInstall = ''
    wrapProgram $out/bin/moosewire \
      --prefix PATH : ${lib.makeBinPath [openssh]}
  '';

  meta = {
    description = "Dual-pane TUI that moves files between local and a remote host over SSH/SCP";
    mainProgram = "moosewire";
    platforms = lib.platforms.linux;
    license = lib.licenses.mit;
  };
}
