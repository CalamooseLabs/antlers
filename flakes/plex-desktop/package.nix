# Plex desktop with fixes for Hyprland and Stylix.
#
# Plain `callPackage`-able builder (not a flake). Wraps the upstream
# plex-desktop so the Qt style override and XDG portal env vars are set.
# Consumed by the root flake as `packages.<system>.plex-desktop`.
{
  symlinkJoin,
  makeWrapper,
  plex-desktop,
}:
symlinkJoin {
  name = "plex-desktop-fixed";
  paths = [plex-desktop];
  buildInputs = [makeWrapper];
  postBuild = ''
    wrapProgram $out/bin/plex-desktop \
      --set QT_STYLE_OVERRIDE "" \
      --set NIXOS_XDG_OPEN_USE_PORTAL 1
  '';
}
