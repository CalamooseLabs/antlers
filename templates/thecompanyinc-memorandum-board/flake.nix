{
  description = "The Company, Inc. — Memorandum of Action of Directors (create-doc wizard)";

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
  } @ inputs: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {
      inherit system;
      config.allowUnfree = true;
    };
  in {
    devShells.${system}.default = import ./shell.nix {
      inherit pkgs inputs;
    };

    # nix build -> result/main.pdf, via the shared antlers legal-doc builder.
    packages.${system}.default = antlers.lib.${system}.mkLegalDoc {src = ./.;};
  };
}
