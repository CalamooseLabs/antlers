{ pkgs ? import <nixpkgs> { }, ... }:

pkgs.stdenv.mkDerivation {
  name = "pdf";
  src = ./.;
  buildInputs = with pkgs; [
    texliveFull
  ];
  buildPhase = ''
    mkdir -p .cache/latex
    latexmk -interaction=nonstopmode -auxdir=.cache/latex -pdf ./src/main.tex
  '';
  installPhase = ''
    mkdir -p $out
    cp main.pdf $out
  '';
}
