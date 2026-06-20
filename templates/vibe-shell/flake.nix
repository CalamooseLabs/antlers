{
  description = "A Claude Code (vibe) dev shell with signed-commit + wiki helpers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    antlers = {
      url = "github:CalamooseLabs/antlers";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    antlers,
    ...
  }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {
      inherit system;
      config.allowUnfree = true;
    };
    # The antlers `vibe` launcher: Claude Code pinned to opus[1m], subscription-first.
    # Customise with mkVibeWrapper { model = …; effort = …; permissions = …; }.
    vibe = antlers.lib.${system}.mkVibeWrapper {};
  in {
    devShells.${system}.default = import ./shell.nix {inherit pkgs vibe;};
  };
}
