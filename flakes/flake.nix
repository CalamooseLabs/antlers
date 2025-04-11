{
  description = "All antler flakes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Reference local flakes
    plex-desktop-flake = {
      url = "github:calamooselabs/antlers/master?dir=flakes/plex-desktop";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    ...
  } @ inputs: let
    # System supported
    system = "x86_64-linux";
    pkgs = import nixpkgs {system = system;};
  in {
    # Re-export the packages from both flakes
    packages."${system}" = {
      plex-desktop = inputs.plex-desktop-flake.packages.${system}.default;
    };

    devShells.${system}.default = import ./shell.nix {
      inherit inputs;
      inherit pkgs;
    };
  };
}
