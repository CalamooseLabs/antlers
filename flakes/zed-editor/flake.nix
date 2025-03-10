{
  description = "Zed Editor with local configurations";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = {nixpkgs, ...}: let
    pkgs = import nixpkgs {system = "x86_64-linux";};
  in {
    packages.x86_64-linux = rec {
      zed-wrapper = settings: let
        # Create the settings JSON file outside the derivation
        defaultSettings = pkgs.writeTextFile {
          name = "default-settings.json";
          text = builtins.toJSON settings;
        };
      in
        pkgs.writeShellScriptBin "zeditor" ''
          # Create a temporary directory for this session
          TEMP_DIR=$(mktemp -d)
          mkdir -p "$TEMP_DIR/zed"

          # Copy the default settings to the temp directory and make it writable
          cp ${defaultSettings} "$TEMP_DIR/zed/settings.json"
          chmod 644 "$TEMP_DIR/zed/settings.json"

          # If user has custom settings, merge them
          USER_SETTINGS="$HOME/.config/zed/settings.json"
          if [ -f "$USER_SETTINGS" ]; then
            ${pkgs.jq}/bin/jq -s ".[0] * .[1]" "$USER_SETTINGS" "$TEMP_DIR/zed/settings.json" > "$TEMP_DIR/zed/merged.json"
            chmod 644 "$TEMP_DIR/zed/merged.json"
            cp "$TEMP_DIR/zed/merged.json" "$TEMP_DIR/zed/settings.json"
            rm "$TEMP_DIR/zed/merged.json"
          fi

          # If user has any extensions already saved
          USER_EXTENSIONS="$HOME/.local/share/zed/extensions"
          if [ -f "$USER_EXTENSIONS" ]; then
            cp -r "$USER_EXTENSIONS" "$TEMP_DIR/zed"
          fi

          mkdir -p "$TEMP_DIR/zed/extensions"

          # Copy any user themes if they exist
          if [ -d "$HOME/.config/zed/themes" ]; then
            mkdir -p "$TEMP_DIR/zed/themes"
            cp -r "$HOME/.config/zed/themes"/* "$TEMP_DIR/zed/themes/" 2>/dev/null || true
          fi

          # Set the temporary config directory for this session only
          export XDG_CONFIG_HOME="$TEMP_DIR"
          export XDG_DATA_HOME="$TEMP_DIR"

          # Clean up temp directory when Zed exits
          trap "rm -rf \"$TEMP_DIR\"" EXIT

          # Run the actual Zed editor
          exec ${pkgs.zed-editor}/bin/zeditor "$@"
        '';

      # Set the default package to be a wrapper with empty settings
      default = zed-wrapper;
    };
  };
}
