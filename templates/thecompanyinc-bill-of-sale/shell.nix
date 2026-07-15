{
  pkgs,
  inputs,
}: let
  antlersLib = inputs.antlers.lib.x86_64-linux;

  zedSettings = {
    auto_install_extensions = {
      "latex" = true;
      "nix" = true;
    };
    soft_wrap = "editor_width";
    lsp = {
      texlab.settings.texlab.build.onSave = false;
      nix.binary.path_lookup = true;
      nil.initialization_options.formatting.command = ["alejandra" "--quiet" "--"];
      nixd.initialization_options.formatting.command = ["alejandra" "--quiet" "--"];
    };
    languages.nix.formatter.external = {
      command = "alejandra";
      arguments = ["--quiet" "--"];
    };
  };
in
  pkgs.mkShell {
    buildInputs = [
      (antlersLib.mkZedWrapper zedSettings)
      antlersLib.docWizard # create-doc + edit-doc
      pkgs.texlab
      pkgs.alejandra
      pkgs.nixd
      pkgs.nil
      pkgs.claude-code
    ];

    shellHook = ''
      # Let texlab / a manual latexmk resolve the shared style during live editing.
      export TEXINPUTS="${antlersLib.thecompanyinc-style}/tex//:''${TEXINPUTS:-}"
      echo -e "\e[4;1mThe Company, Inc. — Bill of Sale and Assignment of Assets 󰷈\e[0m"
      echo ""
      echo "Fill in the bill of sale interactively:"
      echo "   󱞩 create-doc         (new; firm fields prefill from settings.json)"
      echo "   󱞩 edit-doc           (edit the previous answers in doc.json)"
      echo ""
      echo "Build the PDF:"
      echo "   󱞩 nix build          -> result/main.pdf"
    '';
  }
