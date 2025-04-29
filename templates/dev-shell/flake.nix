{
  description = "A nix flake dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {system = system;};
  in {
    devShells.${system}.default = import ./shell.nix {inherit pkgs;};
  };
}
