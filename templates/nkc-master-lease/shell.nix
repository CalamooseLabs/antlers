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

  # Python + the libraries the create-lease TUI needs, baked into a wrapper so the
  # command lands on PATH without putting a bare python3 on it.
  leasePython = pkgs.python3.withPackages (ps: [ps.questionary ps.rich ps.num2words]);
  create-lease = pkgs.writeShellApplication {
    name = "create-lease";
    runtimeInputs = [leasePython pkgs.nix];
    text = ''
      exec ${leasePython}/bin/python ${./scripts}/create_lease.py "$@"
    '';
  };
  # edit-lease — same wizard, but walks the prompts prefilled with the previous
  # answers from lease.json for quick edits (alias for `create-lease --edit`).
  edit-lease = pkgs.writeShellApplication {
    name = "edit-lease";
    runtimeInputs = [leasePython pkgs.nix];
    text = ''
      exec ${leasePython}/bin/python ${./scripts}/create_lease.py --edit "$@"
    '';
  };
in
  pkgs.mkShell {
    buildInputs = [
      (inputs.antlers.lib.x86_64-linux.mkZedWrapper zedSettings)
      create-lease
      edit-lease
      pkgs.texlab
      pkgs.alejandra
      pkgs.nixd
      pkgs.nil
      pkgs.claude-code
      pkgs.libreoffice
    ];

    shellHook = ''
      echo -e "\e[4;1mDocument Creator 󰷈\e[0m"
      echo ""
      echo "To create a new lease interactively:"
      echo "   󱞩 create-lease"
      echo ""
      echo "To edit the previous lease (prompts prefilled for quick edits):"
      echo "   󱞩 edit-lease"
      echo ""
      echo "To Build Run the Following:"
      echo "   󱞩 nix build"
      echo ""
      echo "To add new section run the following:"
      echo "   󱞩 nix flake new :path -t .#[article]"
    '';
  }
