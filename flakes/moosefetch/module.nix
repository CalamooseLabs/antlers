# programs.moosefetch — install the Cala-M-OS fastfetch wrapper with a config
# driven by a keyword list (see ./package.nix).
#
# Imported via either:
#   inputs.antlers.nixosModules.moosefetch        -> environment.systemPackages
#   inputs.antlers.homeManagerModules.moosefetch  -> home.packages
#
# Both expose the SAME option tree under `programs.moosefetch`. `location` selects
# where the package lands: "system" or "home".
location: {
  # A stable `key` so this module DEDUPLICATES if it is ever imported by more than
  # one shim for the same user/host (mirrors flakes/scripts/module.nix).
  _file = "antlers/flakes/moosefetch/module.nix";
  key = "moosefetch-${location}";
  imports = [
    (
      {
        config,
        lib,
        pkgs,
        ...
      }:
        with lib; let
          cfg = config.programs.moosefetch;
          mkMoosefetch = pkgs.callPackage ./package.nix {};
          # Forward everything EXCEPT an empty `modules`: [] means "let the
          # builder's opinionated default layout apply" (forwarding [] would
          # render an empty readout instead).
          pkg = mkMoosefetch ({
              inherit (cfg) logo logoFile logoSize logoColors logoPaddingRight separator keyColor keyMap extraConfig;
            }
            // lib.optionalAttrs (cfg.modules != []) {inherit (cfg) modules;});
        in {
          options.programs.moosefetch = {
            enable = mkEnableOption "moosefetch — the Cala-M-OS fastfetch wrapper";

            logo = mkOption {
              type = types.str;
              default = "cala-m-os";
              example = "calamoose";
              description = ''
                Which brand mark to render as the logo: "calamoose" (Calamoose
                Labs moose head), "cala-m-os" (the gear + moose OS emblem), or
                "none". For a custom image use `logoFile`.
              '';
            };

            logoFile = mkOption {
              type = types.nullOr types.path;
              default = null;
              description = "A custom logo image rendered at build time; overrides `logo`.";
            };

            modules = mkOption {
              type = types.listOf types.str;
              default = [];
              example = ["title" "separator" "os" "kernel" "" "cpu" "memory" "" "colors"];
              description = ''
                Ordered list of keywords, read like a module-import list. Each
                non-empty entry is a fastfetch module type (anything from
                `fastfetch --list-modules`); an empty string "" inserts a blank
                spacer line. Leave empty ([]) to use moosefetch's opinionated
                default layout.
              '';
            };

            logoSize = mkOption {
              type = types.str;
              default = "24x12";
              description = "chafa render size in terminal cells (WxH).";
            };

            logoColors = mkOption {
              type = types.str;
              default = "full";
              description = ''chafa color depth: "full" (24-bit truecolor), "256", "240", "16", "8", "2", or "none".'';
            };

            logoPaddingRight = mkOption {
              type = types.ints.unsigned;
              default = 4;
              description = ''
                Cells of padding between the logo and the info column (the gap).
                Widen it together with a larger `logoSize` to push the info column
                toward the right edge and fill the terminal width.
              '';
            };

            separator = mkOption {
              type = types.str;
              default = "  ";
              description = "The key/value separator between a label and its value.";
            };

            keyColor = mkOption {
              type = types.str;
              default = "";
              example = "blue";
              description = ''A fastfetch color name for the keys (labels), or "" for the default.'';
            };

            keyMap = mkOption {
              type = types.attrsOf (types.attrsOf types.anything);
              default = {};
              example = literalExpression ''{ cpu = { type = "cpu"; key = "  cpu"; }; }'';
              description = "Upgrade a bare keyword into a full fastfetch module object.";
            };

            extraConfig = mkOption {
              type = types.attrs;
              default = {};
              description = "Extra fastfetch config, recursively merged over the generated one.";
            };
          };

          config = mkIf cfg.enable (
            if location == "home"
            then {home.packages = [pkg];}
            else {environment.systemPackages = [pkg];}
          );
        }
    )
  ];
}
