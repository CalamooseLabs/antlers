# antlers — a small CLI that shorthands the antlers flake's templates and packages.
#
# Add it to a NixOS config via the overlay (`pkgs.antlers`) or directly from the
# flake (`inputs.antlers.packages.x86_64-linux.antlers`). At runtime it just calls
# `nix flake new/init -t`, `nix build`, `nix run`, and `nix develop` against the
# flake `defaultRef` (override per-invocation with the ANTLERS_REF env var).
{
  writeShellApplication,
  nix,
  jq,
  util-linux,
  coreutils,
  defaultRef ? "github:CalamooseLabs/antlers",
}:
writeShellApplication {
  name = "antlers";
  runtimeInputs = [nix jq util-linux coreutils];
  text = builtins.replaceStrings ["__DEFAULT_REF__"] [defaultRef] (builtins.readFile ./antlers.sh);
}
