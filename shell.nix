{pkgs}:
pkgs.mkShell {
  packages = [
    pkgs.claude-code
    # Rust toolchain for working on flakes/moosewire (the repo's Rust crate).
    pkgs.cargo
    pkgs.rustc
    pkgs.clippy
    pkgs.rustfmt
    pkgs.rust-analyzer
  ];

  shellHook = ''
    echo "Welcome to antlers a helpful repository"
  '';
}
