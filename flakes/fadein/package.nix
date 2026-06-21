# Fade In — professional screenwriting software (vendored x86_64 tarball,
# autoPatchelf'd onto NixOS). Relocated from the cala-m-os config's
# modules/fade-in so it can be consumed via `inputs.antlers.packages…fadein`
# (or the overlay's `fadein`). Unfree.
{
  lib,
  stdenv,
  autoPatchelfHook,
  makeWrapper,
  wrapGAppsHook3,
  gtk3,
  gdk-pixbuf,
  pango,
  cairo,
  webkitgtk_4_1,
  glib,
  fontconfig,
  curl,
  libxkbcommon,
  wayland,
  util-linux,
  libx11,
  libsm,
  libice,
}:
stdenv.mkDerivation rec {
  pname = "fadein";
  version = "5.0.11";

  src = ./fadein-linux-x64.tar.gz;

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
    wrapGAppsHook3
  ];

  buildInputs = [
    gtk3
    gdk-pixbuf
    pango
    cairo
    webkitgtk_4_1

    glib
    fontconfig
    curl
    libxkbcommon
    wayland
    util-linux

    libx11
    libsm
    libice

    stdenv.cc.cc.lib
  ];

  sourceRoot = ".";

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
        runHook preInstall

        mkdir -p $out/bin
        mkdir -p $out/share/fadein
        mkdir -p $out/share/applications
        mkdir -p $out/share/icons

        # Copy application files from the extracted structure
        cp -r fadein-linux-x86_64-${version}/usr/share/fadein/* $out/share/fadein/

        # Make binary executable and create symlink
        chmod +x $out/share/fadein/fadein
        ln -s $out/share/fadein/fadein $out/bin/fadein

        # Copy desktop file if it exists
        if [ -d "fadein-linux-x86_64-${version}/usr/share/applications" ]; then
          cp -r fadein-linux-x86_64-${version}/usr/share/applications/* $out/share/applications/ || true
        fi

        # Copy icons if they exist
        if [ -d "fadein-linux-x86_64-${version}/usr/share/icons" ]; then
          cp -r fadein-linux-x86_64-${version}/usr/share/icons/* $out/share/icons/ || true
        fi

        # Create desktop entry
        cat > $out/share/applications/fadein.desktop << EOF
    [Desktop Entry]
    Type=Application
    Name=Fade In
    Comment=Professional Screenwriting Software
    Exec=$out/bin/fadein %F
    Icon=fadein
    Terminal=false
    Categories=Office;WordProcessor;
    MimeType=application/x-fadein;
    EOF

        runHook postInstall
  '';

  dontWrapGApps = false;

  meta = with lib; {
    homepage = "https://www.fadeinpro.com";
    description = "Professional screenwriting software";
    license = licenses.unfree;
    platforms = ["x86_64-linux"];
    mainProgram = "fadein";
  };
}
