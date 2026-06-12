# A wrapped Zed editor.
#
# This file is a plain `callPackage`-able builder, NOT a flake. It returns a
# FUNCTION that takes a Zed `settings` attrset and produces a `zeditor`
# launcher. The launcher writes those settings into a throwaway
# XDG_CONFIG_HOME/XDG_DATA_HOME, deep-merges the user's real
# ~/.config/zed/settings.json on top (via `jq -s '.[0] * .[1]'`), copies the
# user's existing extensions/themes, and cleans up on exit -- so a project's
# pinned editor config never clobbers the user's global Zed config.
#
# Consumed by the root flake as `lib.<system>.mkZedWrapper`. A ready-to-run
# derivation (default settings) is exposed as `packages.<system>.zed-editor`.
{
  writeShellScriptBin,
  writeTextFile,
  jq,
  zed-editor,
}: settings: let
  # Serialize the caller's settings to JSON outside the derivation.
  defaultSettings = writeTextFile {
    name = "default-settings.json";
    text = builtins.toJSON settings;
  };
in
  writeShellScriptBin "zeditor" ''
    # Create a temporary directory for this session
    TEMP_DIR=$(mktemp -d)
    mkdir -p "$TEMP_DIR/zed"

    # Copy the default settings to the temp directory and make it writable
    cp ${defaultSettings} "$TEMP_DIR/zed/settings.json"
    chmod 644 "$TEMP_DIR/zed/settings.json"

    # If user has custom settings, merge them. `.[0] * .[1]` deep-merges with
    # the right operand winning, so the project's pinned settings take
    # precedence over the user's global config (original behavior preserved).
    USER_SETTINGS="$HOME/.config/zed/settings.json"
    if [ -f "$USER_SETTINGS" ]; then
      ${jq}/bin/jq -s ".[0] * .[1]" "$USER_SETTINGS" "$TEMP_DIR/zed/settings.json" > "$TEMP_DIR/zed/merged.json"
      chmod 644 "$TEMP_DIR/zed/merged.json"
      cp "$TEMP_DIR/zed/merged.json" "$TEMP_DIR/zed/settings.json"
      rm "$TEMP_DIR/zed/merged.json"
    fi

    # If user has any extensions already saved, carry them over
    USER_EXTENSIONS="$HOME/.local/share/zed/extensions"
    if [ -d "$USER_EXTENSIONS" ]; then
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
    exec ${zed-editor}/bin/zeditor "$@"
  ''
