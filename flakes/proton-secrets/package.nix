# proton-secrets — a headless-friendly wrapper CLI around Proton Pass `pass-cli`,
# and the fetch engine behind services.proton-secrets.
#
# Two `writeShellApplication`s (like flakes/scripts; the bodies are the plain
# files next to this one, so they can be read, linted and tested as scripts):
#
#   proton-secrets-fetch   (./fetch.sh, `passthru.fetch`) — the engine. It owns
#       every pass-cli call: one flock, a timeout per call, a session probe that
#       reads pass-cli's stderr (`pass-cli info`; `test` cannot see a dead session
#       and no longer exists in pass-cli 2.2.4+), the PAT login through the
#       environment, the `logout --force` reset, and the per-secret fetch into
#       ramfs generations. The module runs it from activation and from its units.
#   proton-secrets         (./proton-secrets.sh) — the human-facing front door,
#       a thin dispatcher onto the engine:
#
#   proton-secrets login     # from a PAT (env / file / the module's patFile), else interactive
#   proton-secrets status    # -> `pass-cli info` (there is no upstream `status`)
#   proton-secrets logout
#   proton-secrets resolve pass://SHARE/ITEM/FIELD   # debug: print one value
#   proton-secrets doctor    # what is wrong, without printing a secret
#   proton-secrets repair    # logout --force + log in again from the PAT
#   proton-secrets refresh   # run the fetch unit now and show the result
#
# The session store is pinned to a persistent, out-of-store directory and the `fs`
# key provider, so `pass-cli` works with no dbus/keyring — on servers and inside
# NixOS activation. On a host with the module, the CLI reads the module's manifest
# (`defaultManifest`) to find the PAT file, status file, cache and fetch unit; on a
# box without it (the installer image) it runs from the environment alone.
#
# The bundled `pass-cli` (nixpkgs `proton-pass-cli`) is UNFREE / non-redistributable
# and needs a paid Proton plan; antlers' pkgs set allowUnfree. Downstream consumers
# must permit it too (a narrow allowUnfreePredicate is enough).
{
  lib,
  writeShellApplication,
  proton-pass-cli,
  jq,
  coreutils,
  util-linux,
  diffutils,
  gnugrep,
  gnused,
  gawk,
  systemd,
  # Baked defaults; the environment (module / caller) can override either.
  defaultSessionDir ? "/var/lib/proton-pass-cli",
  defaultKeyProvider ? "fs",
  # Where services.proton-secrets publishes its manifest for this CLI.
  defaultManifest ? "/etc/proton-secrets/manifest.json",
}: let
  fetch = writeShellApplication {
    name = "proton-secrets-fetch";
    # util-linux: flock + mount; diffutils: cmp; systemd: systemctl + systemd-creds.
    runtimeInputs = [proton-pass-cli jq coreutils util-linux diffutils gnugrep gnused gawk systemd];
    text =
      builtins.replaceStrings
      ["__DEFAULT_SESSION_DIR__" "__DEFAULT_KEY_PROVIDER__" "__DEFAULT_MANIFEST__"]
      [defaultSessionDir defaultKeyProvider defaultManifest]
      (builtins.readFile ./fetch.sh);
    meta = {
      description = "Fetch engine of services.proton-secrets (session handling + ramfs generations)";
      mainProgram = "proton-secrets-fetch";
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  };
in
  writeShellApplication {
    name = "proton-secrets";
    text =
      builtins.replaceStrings ["__FETCH__"] [(lib.getExe fetch)]
      (builtins.readFile ./proton-secrets.sh);
    passthru = {inherit fetch;};
    meta = {
      description = "Headless wrapper around Proton Pass pass-cli (fixed session dir + fs key provider)";
      mainProgram = "proton-secrets";
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }
