# Run zeditor to edit the NixOS configuration
config_dir="${EDIT_CONFIG_DIR:-/etc/nixos}"
direnv exec "$config_dir" zeditor "$config_dir"
