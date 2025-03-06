{
  description = "Zed Editor with local configurations";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }:
    let
      pkgs = import nixpkgs { system = "x86_64-linux"; };
    in
    {
      packages.x86_64-linux = rec {
        zed-wrapper = settings:
          let
            # Create the settings JSON file outside the derivation
            settingsJson = pkgs.writeTextFile {
              name = "zed-settings.json";
              text = builtins.toJSON settings;
            };
          in
          pkgs.stdenv.mkDerivation {
            pname = "zed-editor-wrapper";
            version = "1.0.0";

            # Add an empty src to satisfy the requirement
            src = pkgs.emptyDirectory;

            buildInputs = [ pkgs.makeWrapper pkgs.jq pkgs.zed-editor ];

            installPhase = ''
              mkdir -p $out/bin
              mkdir -p $out/.config/zed

              # Copy the settings file to the build directory
              cp ${settingsJson} $out/.config/zed/settings.json

              # Create the zed wrapper with inline configuration
              makeWrapper ${pkgs.zed-editor}/bin/zeditor $out/bin/zeditor \
                --set XDG_CONFIG_HOME "$out/.config" \
                --run '
                  ZED_CONFIG=".config/zed"
                  SETTINGS_PATH="$HOME/$ZED_CONFIG"
                  OVERRIDE_PATH="$out/$ZED_CONFIG"

                  mkdir -p "$OVERRIDE_PATH"

                  if [ -d "$SETTINGS_PATH/themes" ]; then
                    cp -r "$SETTINGS_PATH/themes" "$OVERRIDE_PATH"
                  fi

                  if [ -f "$SETTINGS_PATH/settings.json" ]; then
                    ${pkgs.jq}/bin/jq -s ".[0] * .[1]" "$SETTINGS_PATH/settings.json" "$OVERRIDE_PATH/settings.json" > "$OVERRIDE_PATH/settings.json.new"
                    mv "$OVERRIDE_PATH/settings.json.new" "$OVERRIDE_PATH/settings.json"
                  fi
                '
            '';
          };

        # Set the default package to be a wrapper with empty settings
        default = zed-wrapper {};
      };
    };
}
