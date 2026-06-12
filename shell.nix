{pkgs}:
pkgs.mkShell {
  packages = [
    pkgs.claude-code
  ];

  shellHook = ''
    echo "Welcome to antlers a helpful repository"
  '';
}
