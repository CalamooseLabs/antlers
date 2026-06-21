config_path="${RESTORE_CONFIG_PATH:-/etc/nixos}"

sudo nix-store --verify --repair
nh os switch "$config_path"

# Reset network manager
sudo systemctl restart NetworkManager

