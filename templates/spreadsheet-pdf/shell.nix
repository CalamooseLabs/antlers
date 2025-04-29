{
  pkgs,
  inputs,
}: let
  # Define your zed settings
  zedSettings = {
    auto_install_extensions = {
      "nix" = true;
    };
    soft_wrap = "editor_width";
    lsp = {
      nix = {
        binary = {
          path_lookup = true;
        };
      };
      nil = {
        initialization_options = {
          formatting = {
            command = [
              "alejandra"
              "--quiet"
              "--"
            ];
          };
        };
      };
      nixd = {
        initialization_options = {
          formatting = {
            command = [
              "alejandra"
              "--quiet"
              "--"
            ];
          };
        };
      };
    };
    languages = {
      nix = {
        formatter = {
          external = {
            command = "alejandra";
            arguments = [
              "--quiet"
              "--"
            ];
          };
        };
      };
    };
  };
in
  pkgs.mkShell {
    buildInputs = [
      (inputs.zed-editor.packages.x86_64-linux.default zedSettings)
      pkgs.alejandra
      pkgs.nixd
      pkgs.nil
      pkgs.sc-im
    ];

    shellHook = ''
      echo -e "\e[4;1mPDF SC-IM Creator 󰷈\e[0m"
      echo ""
      echo "To Build Run the Following:"
      echo "   󱞩 nix build"
    '';
  }
