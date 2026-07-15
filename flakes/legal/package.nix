# flakes/legal — shared infrastructure for The Company, Inc. legal documents.
#
# Returns an attrset (wired into the root flake via callPackage), providing:
#   * thecompanyinc-style     — a derivation carrying the ONE canonical style.tex,
#                               installed to a TEXINPUTS-resolvable dir.
#   * mkLegalDoc { src; … }    — the shared latexmk/texliveFull PDF builder (style on
#                               TEXINPUTS) reused by every template AND legal-folder doc,
#                               so no doc copies build.nix.
#   * docWizard               — the shared `create-doc` + `edit-doc` wizard (one engine;
#                               each template supplies only its scripts/manifest.py).
#
# Follows the same "one reusable abstraction, consumed everywhere" pattern as the
# zed-editor wrapper (flakes/zed-editor) already established in this repo.
{
  pkgs ? import <nixpkgs> {},
  lib ? pkgs.lib,
  ...
}: let
  # The single canonical style, installed where kpathsea can find it via TEXINPUTS.
  thecompanyinc-style = pkgs.runCommandLocal "thecompanyinc-style" {} ''
    mkdir -p $out/tex
    cp ${./style/thecompanyinc-style.tex} $out/tex/thecompanyinc-style.tex
  '';

  # Shared PDF builder: latexmk under texliveFull with the canonical style on TEXINPUTS.
  # main.tex loads it with `\input{thecompanyinc-style}`; local nodes via `\subimport{./src}{…}`.
  mkLegalDoc = {
    src,
    pname ? "pdf",
    mainTex ? "src/main.tex",
  }:
    pkgs.stdenv.mkDerivation {
      name = pname;
      inherit src;
      buildInputs = [pkgs.texliveFull];
      buildPhase = ''
        runHook preBuild
        export TEXINPUTS="${thecompanyinc-style}/tex//:"
        latexmk -interaction=nonstopmode -outdir=build -pdf ${mainTex}
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p $out
        cp build/*.pdf $out/
        runHook postInstall
      '';
    };

  # Python with the wizard's TUI deps, baked so the commands land on PATH without a bare python3.
  docPython = pkgs.python3.withPackages (ps: [ps.questionary ps.rich ps.num2words]);
  wizardSrc = ./wizard; # create_doc.py + render_core.py (the DRY engine)

  create-doc = pkgs.writeShellApplication {
    name = "create-doc";
    runtimeInputs = [docPython pkgs.nix];
    text = ''
      exec ${docPython}/bin/python ${wizardSrc}/create_doc.py "$@"
    '';
  };
  # edit-doc — same engine, but walks prompts prefilled from doc.json (= create-doc --edit).
  edit-doc = pkgs.writeShellApplication {
    name = "edit-doc";
    runtimeInputs = [docPython pkgs.nix];
    text = ''
      exec ${docPython}/bin/python ${wizardSrc}/create_doc.py --edit "$@"
    '';
  };

  # One package carrying both commands, for a template shell.nix to drop in buildInputs.
  docWizard = pkgs.symlinkJoin {
    name = "thecompanyinc-doc-wizard";
    paths = [create-doc edit-doc];
  };
in {
  inherit thecompanyinc-style mkLegalDoc docWizard create-doc edit-doc;
}
