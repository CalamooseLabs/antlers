{pkgs ? import <nixpkgs> {}, ...}:
pkgs.stdenv.mkDerivation {
  name = "pdf";
  src = ./.;
  buildInputs = with pkgs; [
    texliveFull
  ];
  buildPhase = ''
    latexmk -interaction=nonstopmode -outdir=build -pdf ./src/main.tex
  '';
  installPhase = ''
    mkdir -p $out
    cp build/main.pdf $out/
  '';
}
