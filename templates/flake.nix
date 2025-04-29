{
  description = "Cala-M-OS NixOS Configuration Flake";

  inputs = {};

  outputs = {...}: {
    templates = import ./templates.nix;
  };
}
