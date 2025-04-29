{pkgs}:
pkgs.mkShell {
  packages = [];

  shellHook = ''
    echo "Welcome to dev shell"
  '';
}
