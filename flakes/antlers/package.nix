# antlers — a small CLI that shorthands the antlers flake's templates and packages.
#
# Add it to a NixOS config via the overlay (`pkgs.antlers`) or directly from the
# flake (`inputs.antlers.packages.x86_64-linux.antlers`). At runtime it just calls
# `nix flake new/init -t`, `nix build`, `nix run`, and `nix develop` against the
# flake `defaultRef` (override per-invocation with the ANTLERS_REF env var).
#
# It also ships a bash completion script (installed where bash-completion's
# lazy-loader finds it), so `antlers <TAB>` completes subcommands and — by
# querying the flake through the hidden `antlers completions` helper — live
# template and package names.
{
  writeShellApplication,
  writeText,
  runCommandLocal,
  installShellFiles,
  shellcheck,
  nix,
  jq,
  util-linux,
  coreutils,
  defaultRef ? "github:CalamooseLabs/antlers",
}: let
  subst = builtins.replaceStrings ["__DEFAULT_REF__"] [defaultRef];

  # The CLI itself — writeShellApplication adds the shebang, `set -euo pipefail`,
  # and the build-time shellcheck gate.
  antlers = writeShellApplication {
    name = "antlers";
    runtimeInputs = [nix jq util-linux coreutils];
    text = subst (builtins.readFile ./antlers.sh);
  };

  completion = writeText "antlers.bash" (subst (builtins.readFile ./antlers-completion.bash));
in
  # Combine the CLI with its completion under one derivation so `pkgs.antlers`
  # carries both `bin/antlers` and the bash completion. The script is *copied*
  # (not symlinked) so the binary and its completion share one store prefix —
  # bash-completion's lazy loader resolves a command's real path to find the
  # adjacent `share/bash-completion/completions/antlers.bash`, which an
  # indirection through a second store path would defeat. (The shellcheck/format
  # gates already ran when `antlers` was built; the script bakes absolute store
  # paths, so it is location-independent.)
  runCommandLocal "antlers" {
    nativeBuildInputs = [installShellFiles shellcheck];
    meta = antlers.meta or {};
    passthru = {inherit antlers;};
  } ''
    shellcheck ${completion}
    install -Dm755 ${antlers}/bin/antlers "$out/bin/antlers"
    installShellCompletion --cmd antlers --bash ${completion}
  ''
