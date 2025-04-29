{
  pkgs,
  inputs,
}: let
  # Define your zed settings
  zedSettings = {
    auto_install_extensions = {
      "latex" = true;
      "nix" = true;
    };
    soft_wrap = "editor_width";
    lsp = {
      texlab = {
        settings = {
          texlab = {
            build = {
              onSave = false;
            };
          };
        };
      };
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
      pkgs.texlab
      pkgs.alejandra
      pkgs.nixd
      pkgs.nil
    ];

    shellHook = ''
      echo -e "\e[4;1mFarmland Lease Amendment Creator 󰷈\e[0m"
      echo ""
      echo "To Build Run the Following:"
      echo "   󱞩 nix build"
      echo ""
      echo "To add new section run the following:"
      echo "   󱞩 nix flake new :path -t .#[article|section|subsection|subsubsection]"
    '';
  }
