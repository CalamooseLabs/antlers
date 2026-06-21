# Resolve programs.vibe.presets' null pin overrides against the top-level
# programs.vibe.* defaults, so the vibe launcher module and the vibe-server module
# bake IDENTICAL, fully-resolved presets into the launcher. A null
# model/effort/ultracode/permissionMode/permissions on a preset means "inherit the
# global programs.vibe value". Imported as `import ./presets.nix lib <pcfg>`.
lib: pcfg:
lib.mapAttrs (_: p: {
  inherit (p) directories branch pushRemote commitRequiresTouch pushRequiresTouch;
  model =
    if p.model != null
    then p.model
    else pcfg.model;
  effort =
    if p.effort != null
    then p.effort
    else pcfg.effort;
  ultracode =
    if p.ultracode != null
    then p.ultracode
    else pcfg.ultracode;
  permissionMode =
    if p.permissionMode != null
    then p.permissionMode
    else pcfg.permissionMode;
  permissions =
    if p.permissions != null
    then p.permissions
    else pcfg.permissions;
})
pcfg.presets
